import { FileLoader, ImageBitmapLoader, TextureLoader } from 'three'

import { addUnknownExtensionsToUserData } from './addUnknownExtensionsToUserData'
import { assignExtrasToUserData } from './assignExtrasToUserData'
import { createPrimitiveKey } from './createPrimitiveKey'
import { getNormalizedComponentScale } from './getNormalizedComponentScale'
import { GLTFRegistry } from './GLTFRegistry'
import { resolveURL } from './resolveURL'

export class GLTFParser {
  constructor(json = {}, options = {}) {
    this.json = json
    this.extensions = {}
    this.plugins = {}
    this.options = options

    // loader object cache
    this.cache = new GLTFRegistry()

    // associations between Three.js objects and glTF elements
    this.associations = new Map()

    // BufferGeometry caching
    this.primitiveCache = {}

    // Object3D instance caches
    this.meshCache = { refs: {}, uses: {} }
    this.cameraCache = { refs: {}, uses: {} }
    this.lightCache = { refs: {}, uses: {} }

    this.textureCache = {}

    // Track node names, to ensure no duplicates
    this.nodeNamesUsed = {}

    // Use an ImageBitmapLoader if imageBitmaps are supported. Moves much of the
    // expensive work of uploading a texture to the GPU off the main thread.
    if (typeof createImageBitmap !== 'undefined' && /Firefox/.test(navigator.userAgent) === false) {
      this.textureLoader = new ImageBitmapLoader(this.options.manager)
    } else {
      this.textureLoader = new TextureLoader(this.options.manager)
    }

    this.textureLoader.setCrossOrigin(this.options.crossOrigin)
    this.textureLoader.setRequestHeader(this.options.requestHeader)

    this.fileLoader = new FileLoader(this.options.manager)
    this.fileLoader.setResponseType('arraybuffer')

    if (this.options.crossOrigin === 'use-credentials') {
      this.fileLoader.setWithCredentials(true)
    }
  }

  setExtensions(extensions) {
    this.extensions = extensions
  }

  setPlugins(plugins) {
    this.plugins = plugins
  }

  parse(onLoad, onError) {
    const parser = this
    const json = this.json
    const extensions = this.extensions

    // Clear the loader cache
    this.cache.removeAll()

    // Mark the special nodes/meshes in json for efficient parse
    this._invokeAll(function (ext) {
      return ext._markDefs && ext._markDefs()
    })

    Promise.all(
      this._invokeAll(function (ext) {
        return ext.beforeRoot && ext.beforeRoot()
      }),
    )
      .then(function () {
        return Promise.all([
          parser.getDependencies('scene'),
          parser.getDependencies('animation'),
          parser.getDependencies('camera'),
        ])
      })
      .then(function (dependencies) {
        const result = {
          scene: dependencies[0][json.scene || 0],
          scenes: dependencies[0],
          animations: dependencies[1],
          cameras: dependencies[2],
          asset: json.asset,
          parser: parser,
          userData: {},
        }

        addUnknownExtensionsToUserData(extensions, result, json)

        assignExtrasToUserData(result, json)

        Promise.all(
          parser._invokeAll(function (ext) {
            return ext.afterRoot && ext.afterRoot(result)
          }),
        ).then(function () {
          onLoad(result)
        })
      })
      .catch(onError)
  }

  /**
   * Marks the special nodes/meshes in json for efficient parse.
   */
  _markDefs() {
    const nodeDefs = this.json.nodes || []
    const skinDefs = this.json.skins || []
    const meshDefs = this.json.meshes || []

    // Nothing in the node definition indicates whether it is a Bone or an
    // Object3D. Use the skins' joint references to mark bones.
    for (let skinIndex = 0, skinLength = skinDefs.length; skinIndex < skinLength; skinIndex++) {
      const joints = skinDefs[skinIndex].joints

      for (let i = 0, il = joints.length; i < il; i++) {
        nodeDefs[joints[i]].isBone = true
      }
    }

    // Iterate over all nodes, marking references to shared resources,
    // as well as skeleton joints.
    for (let nodeIndex = 0, nodeLength = nodeDefs.length; nodeIndex < nodeLength; nodeIndex++) {
      const nodeDef = nodeDefs[nodeIndex]

      if (nodeDef.mesh !== undefined) {
        this._addNodeRef(this.meshCache, nodeDef.mesh)

        // Nothing in the mesh definition indicates whether it is
        // a SkinnedMesh or Mesh. Use the node's mesh reference
        // to mark SkinnedMesh if node has skin.
        if (nodeDef.skin !== undefined) {
          meshDefs[nodeDef.mesh].isSkinnedMesh = true
        }
      }

      if (nodeDef.camera !== undefined) {
        this._addNodeRef(this.cameraCache, nodeDef.camera)
      }
    }
  }

  /**
   * Counts references to shared node / Object3D resources. These resources
   * can be reused, or "instantiated", at multiple nodes in the scene
   * hierarchy. Mesh, Camera, and Light instances are instantiated and must
   * be marked. Non-scenegraph resources (like Materials, Geometries, and
   * Textures) can be reused directly and are not marked here.
   *
   * Example: CesiumMilkTruck sample model reuses "Wheel" meshes.
   */
  _addNodeRef(cache, index) {
    if (index === undefined) return

    if (cache.refs[index] === undefined) {
      cache.refs[index] = cache.uses[index] = 0
    }

    cache.refs[index]++
  }

  /** Returns a reference to a shared resource, cloning it if necessary. */
  _getNodeRef(cache, index, object) {
    if (cache.refs[index] <= 1) return object

    const ref = object.clone()

    ref.name += '_instance_' + cache.uses[index]++

    return ref
  }

  _invokeOne(func) {
    const extensions = Object.values(this.plugins)
    extensions.push(this)

    for (let i = 0; i < extensions.length; i++) {
      const result = func(extensions[i])

      if (result) return result
    }

    return null
  }

  _invokeAll(func) {
    const extensions = Object.values(this.plugins)
    extensions.unshift(this)

    const pending = []

    for (let i = 0; i < extensions.length; i++) {
      const result = func(extensions[i])

      if (result) pending.push(result)
    }

    return pending
  }

  /**
   * Requests the specified dependency asynchronously, with caching.
   * @param {string} type
   * @param {number} index
   * @return {Promise<Object3D|Material|THREE.Texture|AnimationClip|ArrayBuffer|Object>}
   */
  getDependency(type, index) {
    const cacheKey = type + ':' + index
    let dependency = this.cache.get(cacheKey)

    if (!dependency) {
      switch (type) {
        case 'scene':
          dependency = this.loadScene(index)
          break

        case 'node':
          dependency = this.loadNode(index)
          break

        case 'mesh':
          dependency = this._invokeOne(function (ext) {
            return ext.loadMesh && ext.loadMesh(index)
          })
          break

        case 'accessor':
          dependency = this.loadAccessor(index)
          break

        case 'bufferView':
          dependency = this._invokeOne(function (ext) {
            return ext.loadBufferView && ext.loadBufferView(index)
          })
          break

        case 'buffer':
          dependency = this.loadBuffer(index)
          break

        case 'material':
          dependency = this._invokeOne(function (ext) {
            return ext.loadMaterial && ext.loadMaterial(index)
          })
          break

        case 'texture':
          dependency = this._invokeOne(function (ext) {
            return ext.loadTexture && ext.loadTexture(index)
          })
          break

        case 'skin':
          dependency = this.loadSkin(index)
          break

        case 'animation':
          dependency = this.loadAnimation(index)
          break

        case 'camera':
          dependency = this.loadCamera(index)
          break

        default:
          throw new Error('Unknown type: ' + type)
      }

      this.cache.add(cacheKey, dependency)
    }

    return dependency
  }

  /**
   * Requests all dependencies of the specified type asynchronously, with caching.
   * @param {string} type
   * @return {Promise<Array<Object>>}
   */
  getDependencies(type) {
    let dependencies = this.cache.get(type)

    if (!dependencies) {
      const parser = this
      const defs = this.json[type + (type === 'mesh' ? 'es' : 's')] || []

      dependencies = Promise.all(
        defs.map(function (def, index) {
          return parser.getDependency(type, index)
        }),
      )

      this.cache.add(type, dependencies)
    }

    return dependencies
  }

  /**
   * Specification: https://github.com/KhronosGroup/glTF/blob/master/specification/2.0/README.md#buffers-and-buffer-views
   * @param {number} bufferIndex
   * @return {Promise<ArrayBuffer>}
   */
  loadBuffer(bufferIndex) {
    const bufferDef = this.json.buffers[bufferIndex]
    const loader = this.fileLoader

    if (bufferDef.type && bufferDef.type !== 'arraybuffer') {
      throw new Error('THREE.GLTFLoader: ' + bufferDef.type + ' buffer type is not supported.')
    }

    // If present, GLB container is required to be the first buffer.
    if (bufferDef.uri === undefined && bufferIndex === 0) {
      return Promise.resolve(this.extensions[EXTENSIONS.KHR_BINARY_GLTF].body)
    }

    const options = this.options

    return new Promise(function (resolve, reject) {
      loader.load(resolveURL(bufferDef.uri, options.path), resolve, undefined, function () {
        reject(new Error('THREE.GLTFLoader: Failed to load buffer "' + bufferDef.uri + '".'))
      })
    })
  }

  /**
   * Specification: https://github.com/KhronosGroup/glTF/blob/master/specification/2.0/README.md#buffers-and-buffer-views
   * @param {number} bufferViewIndex
   * @return {Promise<ArrayBuffer>}
   */
  loadBufferView(bufferViewIndex) {
    const bufferViewDef = this.json.bufferViews[bufferViewIndex]

    return this.getDependency('buffer', bufferViewDef.buffer).then(function (buffer) {
      const byteLength = bufferViewDef.byteLength || 0
      const byteOffset = bufferViewDef.byteOffset || 0
      return buffer.slice(byteOffset, byteOffset + byteLength)
    })
  }

  /**
   * Specification: https://github.com/KhronosGroup/glTF/blob/master/specification/2.0/README.md#accessors
   * @param {number} accessorIndex
   * @return {Promise<BufferAttribute|InterleavedBufferAttribute>}
   */
  loadAccessor(accessorIndex) {
    const parser = this
    const json = this.json

    const accessorDef = this.json.accessors[accessorIndex]

    if (accessorDef.bufferView === undefined && accessorDef.sparse === undefined) {
      // Ignore empty accessors, which may be used to declare runtime
      // information about attributes coming from another source (e.g. Draco
      // compression extension).
      return Promise.resolve(null)
    }

    const pendingBufferViews = []

    if (accessorDef.bufferView !== undefined) {
      pendingBufferViews.push(this.getDependency('bufferView', accessorDef.bufferView))
    } else {
      pendingBufferViews.push(null)
    }

    if (accessorDef.sparse !== undefined) {
      pendingBufferViews.push(this.getDependency('bufferView', accessorDef.sparse.indices.bufferView))
      pendingBufferViews.push(this.getDependency('bufferView', accessorDef.sparse.values.bufferView))
    }

    return Promise.all(pendingBufferViews).then(function (bufferViews) {
      const bufferView = bufferViews[0]

      const itemSize = WEBGL_TYPE_SIZES[accessorDef.type]
      const TypedArray = WEBGL_COMPONENT_TYPES[accessorDef.componentType]

      // For VEC3: itemSize is 3, elementBytes is 4, itemBytes is 12.
      const elementBytes = TypedArray.BYTES_PER_ELEMENT
      const itemBytes = elementBytes * itemSize
      const byteOffset = accessorDef.byteOffset || 0
      const byteStride =
        accessorDef.bufferView !== undefined ? json.bufferViews[accessorDef.bufferView].byteStride : undefined
      const normalized = accessorDef.normalized === true
      let array, bufferAttribute

      // The buffer is not interleaved if the stride is the item size in bytes.
      if (byteStride && byteStride !== itemBytes) {
        // Each "slice" of the buffer, as defined by 'count' elements of 'byteStride' bytes, gets its own InterleavedBuffer
        // This makes sure that IBA.count reflects accessor.count properly
        const ibSlice = Math.floor(byteOffset / byteStride)
        const ibCacheKey =
          'InterleavedBuffer:' +
          accessorDef.bufferView +
          ':' +
          accessorDef.componentType +
          ':' +
          ibSlice +
          ':' +
          accessorDef.count
        let ib = parser.cache.get(ibCacheKey)

        if (!ib) {
          array = new TypedArray(bufferView, ibSlice * byteStride, (accessorDef.count * byteStride) / elementBytes)

          // Integer parameters to IB/IBA are in array elements, not bytes.
          ib = new InterleavedBuffer(array, byteStride / elementBytes)

          parser.cache.add(ibCacheKey, ib)
        }

        bufferAttribute = new InterleavedBufferAttribute(
          ib,
          itemSize,
          (byteOffset % byteStride) / elementBytes,
          normalized,
        )
      } else {
        if (bufferView === null) {
          array = new TypedArray(accessorDef.count * itemSize)
        } else {
          array = new TypedArray(bufferView, byteOffset, accessorDef.count * itemSize)
        }

        bufferAttribute = new BufferAttribute(array, itemSize, normalized)
      }

      // https://github.com/KhronosGroup/glTF/blob/master/specification/2.0/README.md#sparse-accessors
      if (accessorDef.sparse !== undefined) {
        const itemSizeIndices = WEBGL_TYPE_SIZES.SCALAR
        const TypedArrayIndices = WEBGL_COMPONENT_TYPES[accessorDef.sparse.indices.componentType]

        const byteOffsetIndices = accessorDef.sparse.indices.byteOffset || 0
        const byteOffsetValues = accessorDef.sparse.values.byteOffset || 0

        const sparseIndices = new TypedArrayIndices(
          bufferViews[1],
          byteOffsetIndices,
          accessorDef.sparse.count * itemSizeIndices,
        )
        const sparseValues = new TypedArray(bufferViews[2], byteOffsetValues, accessorDef.sparse.count * itemSize)

        if (bufferView !== null) {
          // Avoid modifying the original ArrayBuffer, if the bufferView wasn't initialized with zeroes.
          bufferAttribute = new BufferAttribute(
            bufferAttribute.array.slice(),
            bufferAttribute.itemSize,
            bufferAttribute.normalized,
          )
        }

        for (let i = 0, il = sparseIndices.length; i < il; i++) {
          const index = sparseIndices[i]

          bufferAttribute.setX(index, sparseValues[i * itemSize])
          if (itemSize >= 2) bufferAttribute.setY(index, sparseValues[i * itemSize + 1])
          if (itemSize >= 3) bufferAttribute.setZ(index, sparseValues[i * itemSize + 2])
          if (itemSize >= 4) bufferAttribute.setW(index, sparseValues[i * itemSize + 3])
          if (itemSize >= 5) throw new Error('THREE.GLTFLoader: Unsupported itemSize in sparse BufferAttribute.')
        }
      }

      return bufferAttribute
    })
  }

  /**
   * Specification: https://github.com/KhronosGroup/glTF/tree/master/specification/2.0#textures
   * @param {number} textureIndex
   * @return {Promise<THREE.Texture>}
   */
  loadTexture(textureIndex) {
    const json = this.json
    const options = this.options
    const textureDef = json.textures[textureIndex]
    const source = json.images[textureDef.source]

    let loader = this.textureLoader

    if (source.uri) {
      const handler = options.manager.getHandler(source.uri)
      if (handler !== null) loader = handler
    }

    return this.loadTextureImage(textureIndex, source, loader)
  }

  loadTextureImage(textureIndex, source, loader) {
    const parser = this
    const json = this.json
    const options = this.options

    const textureDef = json.textures[textureIndex]

    const cacheKey = (source.uri || source.bufferView) + ':' + textureDef.sampler

    if (this.textureCache[cacheKey]) {
      // See https://github.com/mrdoob/three.js/issues/21559.
      return this.textureCache[cacheKey]
    }

    const URL = self.URL || self.webkitURL

    let sourceURI = source.uri || ''
    let isObjectURL = false
    let hasAlpha = true

    const isJPEG = sourceURI.search(/\.jpe?g($|\?)/i) > 0 || sourceURI.search(/^data\:image\/jpeg/) === 0

    if (source.mimeType === 'image/jpeg' || isJPEG) hasAlpha = false

    if (source.bufferView !== undefined) {
      // Load binary image data from bufferView, if provided.

      sourceURI = parser.getDependency('bufferView', source.bufferView).then(function (bufferView) {
        if (source.mimeType === 'image/png') {
          // Inspect the PNG 'IHDR' chunk to determine whether the image could have an
          // alpha channel. This check is conservative — the image could have an alpha
          // channel with all values == 1, and the indexed type (colorType == 3) only
          // sometimes contains alpha.
          //
          // https://en.wikipedia.org/wiki/Portable_Network_Graphics#File_header
          const colorType = new DataView(bufferView, 25, 1).getUint8(0, false)
          hasAlpha = colorType === 6 || colorType === 4 || colorType === 3
        }

        isObjectURL = true
        const blob = new Blob([bufferView], { type: source.mimeType })
        sourceURI = URL.createObjectURL(blob)
        return sourceURI
      })
    } else if (source.uri === undefined) {
      throw new Error('THREE.GLTFLoader: Image ' + textureIndex + ' is missing URI and bufferView')
    }

    const promise = Promise.resolve(sourceURI)
      .then(function (sourceURI) {
        return new Promise(function (resolve, reject) {
          let onLoad = resolve

          if (loader.isImageBitmapLoader === true) {
            onLoad = function (imageBitmap) {
              const texture = new Texture(imageBitmap)
              texture.needsUpdate = true

              resolve(texture)
            }
          }

          loader.load(resolveURL(sourceURI, options.path), onLoad, undefined, reject)
        })
      })
      .then(function (texture) {
        // Clean up resources and configure Texture.

        if (isObjectURL === true) {
          URL.revokeObjectURL(sourceURI)
        }

        texture.flipY = false

        if (textureDef.name) texture.name = textureDef.name

        // When there is definitely no alpha channel in the texture, set RGBFormat to save space.
        if (!hasAlpha) texture.format = RGBFormat

        const samplers = json.samplers || {}
        const sampler = samplers[textureDef.sampler] || {}

        texture.magFilter = WEBGL_FILTERS[sampler.magFilter] || LinearFilter
        texture.minFilter = WEBGL_FILTERS[sampler.minFilter] || LinearMipmapLinearFilter
        texture.wrapS = WEBGL_WRAPPINGS[sampler.wrapS] || RepeatWrapping
        texture.wrapT = WEBGL_WRAPPINGS[sampler.wrapT] || RepeatWrapping

        parser.associations.set(texture, {
          type: 'textures',
          index: textureIndex,
        })

        return texture
      })
      .catch(function () {
        console.error("THREE.GLTFLoader: Couldn't load texture", sourceURI)
        return null
      })

    this.textureCache[cacheKey] = promise

    return promise
  }

  /**
   * Asynchronously assigns a texture to the given material parameters.
   * @param {Object} materialParams
   * @param {string} mapName
   * @param {Object} mapDef
   * @return {Promise<Texture>}
   */
  assignTexture(materialParams, mapName, mapDef) {
    const parser = this

    return this.getDependency('texture', mapDef.index).then(function (texture) {
      // Materials sample aoMap from UV set 1 and other maps from UV set 0 - this can't be configured
      // However, we will copy UV set 0 to UV set 1 on demand for aoMap
      if (mapDef.texCoord !== undefined && mapDef.texCoord != 0 && !(mapName === 'aoMap' && mapDef.texCoord == 1)) {
        console.warn(
          'THREE.GLTFLoader: Custom UV set ' + mapDef.texCoord + ' for texture ' + mapName + ' not yet supported.',
        )
      }

      if (parser.extensions[EXTENSIONS.KHR_TEXTURE_TRANSFORM]) {
        const transform =
          mapDef.extensions !== undefined ? mapDef.extensions[EXTENSIONS.KHR_TEXTURE_TRANSFORM] : undefined

        if (transform) {
          const gltfReference = parser.associations.get(texture)
          texture = parser.extensions[EXTENSIONS.KHR_TEXTURE_TRANSFORM].extendTexture(texture, transform)
          parser.associations.set(texture, gltfReference)
        }
      }

      materialParams[mapName] = texture

      return texture
    })
  }

  /**
   * Assigns final material to a Mesh, Line, or Points instance. The instance
   * already has a material (generated from the glTF material options alone)
   * but reuse of the same glTF material may require multiple threejs materials
   * to accommodate different primitive types, defines, etc. New materials will
   * be created if necessary, and reused from a cache.
   * @param  {Object3D} mesh Mesh, Line, or Points instance.
   */
  assignFinalMaterial(mesh) {
    const geometry = mesh.geometry
    let material = mesh.material

    const useVertexTangents = geometry.attributes.tangent !== undefined
    const useVertexColors = geometry.attributes.color !== undefined
    const useFlatShading = geometry.attributes.normal === undefined

    if (mesh.isPoints) {
      const cacheKey = 'PointsMaterial:' + material.uuid

      let pointsMaterial = this.cache.get(cacheKey)

      if (!pointsMaterial) {
        pointsMaterial = new PointsMaterial()
        Material.prototype.copy.call(pointsMaterial, material)
        pointsMaterial.color.copy(material.color)
        pointsMaterial.map = material.map
        pointsMaterial.sizeAttenuation = false // glTF spec says points should be 1px

        this.cache.add(cacheKey, pointsMaterial)
      }

      material = pointsMaterial
    } else if (mesh.isLine) {
      const cacheKey = 'LineBasicMaterial:' + material.uuid

      let lineMaterial = this.cache.get(cacheKey)

      if (!lineMaterial) {
        lineMaterial = new LineBasicMaterial()
        Material.prototype.copy.call(lineMaterial, material)
        lineMaterial.color.copy(material.color)

        this.cache.add(cacheKey, lineMaterial)
      }

      material = lineMaterial
    }

    // Clone the material if it will be modified
    if (useVertexTangents || useVertexColors || useFlatShading) {
      let cacheKey = 'ClonedMaterial:' + material.uuid + ':'

      if (material.isGLTFSpecularGlossinessMaterial) cacheKey += 'specular-glossiness:'
      if (useVertexTangents) cacheKey += 'vertex-tangents:'
      if (useVertexColors) cacheKey += 'vertex-colors:'
      if (useFlatShading) cacheKey += 'flat-shading:'

      let cachedMaterial = this.cache.get(cacheKey)

      if (!cachedMaterial) {
        cachedMaterial = material.clone()

        if (useVertexColors) cachedMaterial.vertexColors = true
        if (useFlatShading) cachedMaterial.flatShading = true

        if (useVertexTangents) {
          // https://github.com/mrdoob/three.js/issues/11438#issuecomment-507003995
          if (cachedMaterial.normalScale) cachedMaterial.normalScale.y *= -1
          if (cachedMaterial.clearcoatNormalScale) cachedMaterial.clearcoatNormalScale.y *= -1
        }

        this.cache.add(cacheKey, cachedMaterial)

        this.associations.set(cachedMaterial, this.associations.get(material))
      }

      material = cachedMaterial
    }

    // workarounds for mesh and geometry

    if (material.aoMap && geometry.attributes.uv2 === undefined && geometry.attributes.uv !== undefined) {
      geometry.setAttribute('uv2', geometry.attributes.uv)
    }

    mesh.material = material
  }

  getMaterialType(/* materialIndex */) {
    return MeshStandardMaterial
  }

  /**
   * Specification: https://github.com/KhronosGroup/glTF/blob/master/specification/2.0/README.md#materials
   * @param {number} materialIndex
   * @return {Promise<Material>}
   */
  loadMaterial(materialIndex) {
    const parser = this
    const json = this.json
    const extensions = this.extensions
    const materialDef = json.materials[materialIndex]

    let materialType
    const materialParams = {}
    const materialExtensions = materialDef.extensions || {}

    const pending = []

    if (materialExtensions[EXTENSIONS.KHR_MATERIALS_PBR_SPECULAR_GLOSSINESS]) {
      const sgExtension = extensions[EXTENSIONS.KHR_MATERIALS_PBR_SPECULAR_GLOSSINESS]
      materialType = sgExtension.getMaterialType()
      pending.push(sgExtension.extendParams(materialParams, materialDef, parser))
    } else if (materialExtensions[EXTENSIONS.KHR_MATERIALS_UNLIT]) {
      const kmuExtension = extensions[EXTENSIONS.KHR_MATERIALS_UNLIT]
      materialType = kmuExtension.getMaterialType()
      pending.push(kmuExtension.extendParams(materialParams, materialDef, parser))
    } else {
      // Specification:
      // https://github.com/KhronosGroup/glTF/tree/master/specification/2.0#metallic-roughness-material

      const metallicRoughness = materialDef.pbrMetallicRoughness || {}

      materialParams.color = new Color(1.0, 1.0, 1.0)
      materialParams.opacity = 1.0

      if (Array.isArray(metallicRoughness.baseColorFactor)) {
        const array = metallicRoughness.baseColorFactor

        materialParams.color.fromArray(array)
        materialParams.opacity = array[3]
      }

      if (metallicRoughness.baseColorTexture !== undefined) {
        pending.push(parser.assignTexture(materialParams, 'map', metallicRoughness.baseColorTexture))
      }

      materialParams.metalness = metallicRoughness.metallicFactor !== undefined ? metallicRoughness.metallicFactor : 1.0
      materialParams.roughness =
        metallicRoughness.roughnessFactor !== undefined ? metallicRoughness.roughnessFactor : 1.0

      if (metallicRoughness.metallicRoughnessTexture !== undefined) {
        pending.push(parser.assignTexture(materialParams, 'metalnessMap', metallicRoughness.metallicRoughnessTexture))
        pending.push(parser.assignTexture(materialParams, 'roughnessMap', metallicRoughness.metallicRoughnessTexture))
      }

      materialType = this._invokeOne(function (ext) {
        return ext.getMaterialType && ext.getMaterialType(materialIndex)
      })

      pending.push(
        Promise.all(
          this._invokeAll(function (ext) {
            return ext.extendMaterialParams && ext.extendMaterialParams(materialIndex, materialParams)
          }),
        ),
      )
    }

    if (materialDef.doubleSided === true) {
      materialParams.side = DoubleSide
    }

    const alphaMode = materialDef.alphaMode || ALPHA_MODES.OPAQUE

    if (alphaMode === ALPHA_MODES.BLEND) {
      materialParams.transparent = true

      // See: https://github.com/mrdoob/three.js/issues/17706
      materialParams.depthWrite = false
    } else {
      materialParams.transparent = false

      if (alphaMode === ALPHA_MODES.MASK) {
        materialParams.alphaTest = materialDef.alphaCutoff !== undefined ? materialDef.alphaCutoff : 0.5
      }
    }

    if (materialDef.normalTexture !== undefined && materialType !== MeshBasicMaterial) {
      pending.push(parser.assignTexture(materialParams, 'normalMap', materialDef.normalTexture))

      // https://github.com/mrdoob/three.js/issues/11438#issuecomment-507003995
      materialParams.normalScale = new Vector2(1, -1)

      if (materialDef.normalTexture.scale !== undefined) {
        materialParams.normalScale.set(materialDef.normalTexture.scale, -materialDef.normalTexture.scale)
      }
    }

    if (materialDef.occlusionTexture !== undefined && materialType !== MeshBasicMaterial) {
      pending.push(parser.assignTexture(materialParams, 'aoMap', materialDef.occlusionTexture))

      if (materialDef.occlusionTexture.strength !== undefined) {
        materialParams.aoMapIntensity = materialDef.occlusionTexture.strength
      }
    }

    if (materialDef.emissiveFactor !== undefined && materialType !== MeshBasicMaterial) {
      materialParams.emissive = new Color().fromArray(materialDef.emissiveFactor)
    }

    if (materialDef.emissiveTexture !== undefined && materialType !== MeshBasicMaterial) {
      pending.push(parser.assignTexture(materialParams, 'emissiveMap', materialDef.emissiveTexture))
    }

    return Promise.all(pending).then(function () {
      let material

      if (materialType === GLTFMeshStandardSGMaterial) {
        material = extensions[EXTENSIONS.KHR_MATERIALS_PBR_SPECULAR_GLOSSINESS].createMaterial(materialParams)
      } else {
        material = new materialType(materialParams)
      }

      if (materialDef.name) material.name = materialDef.name

      // baseColorTexture, emissiveTexture, and specularGlossinessTexture use sRGB encoding.
      if (material.map) material.map.encoding = sRGBEncoding
      if (material.emissiveMap) material.emissiveMap.encoding = sRGBEncoding

      assignExtrasToUserData(material, materialDef)

      parser.associations.set(material, { type: 'materials', index: materialIndex })

      if (materialDef.extensions) addUnknownExtensionsToUserData(extensions, material, materialDef)

      return material
    })
  }

  /** When Object3D instances are targeted by animation, they need unique names. */
  createUniqueName(originalName) {
    const sanitizedName = PropertyBinding.sanitizeNodeName(originalName || '')

    let name = sanitizedName

    for (let i = 1; this.nodeNamesUsed[name]; ++i) {
      name = sanitizedName + '_' + i
    }

    this.nodeNamesUsed[name] = true

    return name
  }

  /**
   * Specification: https://github.com/KhronosGroup/glTF/blob/master/specification/2.0/README.md#geometry
   *
   * Creates BufferGeometries from primitives.
   *
   * @param {Array<GLTF.Primitive>} primitives
   * @return {Promise<Array<BufferGeometry>>}
   */
  loadGeometries(primitives) {
    const parser = this
    const extensions = this.extensions
    const cache = this.primitiveCache

    function createDracoPrimitive(primitive) {
      return extensions[EXTENSIONS.KHR_DRACO_MESH_COMPRESSION]
        .decodePrimitive(primitive, parser)
        .then(function (geometry) {
          return addPrimitiveAttributes(geometry, primitive, parser)
        })
    }

    const pending = []

    for (let i = 0, il = primitives.length; i < il; i++) {
      const primitive = primitives[i]
      const cacheKey = createPrimitiveKey(primitive)

      // See if we've already created this geometry
      const cached = cache[cacheKey]

      if (cached) {
        // Use the cached geometry if it exists
        pending.push(cached.promise)
      } else {
        let geometryPromise

        if (primitive.extensions && primitive.extensions[EXTENSIONS.KHR_DRACO_MESH_COMPRESSION]) {
          // Use DRACO geometry if available
          geometryPromise = createDracoPrimitive(primitive)
        } else {
          // Otherwise create a new geometry
          geometryPromise = addPrimitiveAttributes(new BufferGeometry(), primitive, parser)
        }

        // Cache this geometry
        cache[cacheKey] = { primitive: primitive, promise: geometryPromise }

        pending.push(geometryPromise)
      }
    }

    return Promise.all(pending)
  }

  /**
   * Specification: https://github.com/KhronosGroup/glTF/blob/master/specification/2.0/README.md#meshes
   * @param {number} meshIndex
   * @return {Promise<Group|Mesh|SkinnedMesh>}
   */
  loadMesh(meshIndex) {
    const parser = this
    const json = this.json
    const extensions = this.extensions

    const meshDef = json.meshes[meshIndex]
    const primitives = meshDef.primitives

    const pending = []

    for (let i = 0, il = primitives.length; i < il; i++) {
      const material =
        primitives[i].material === undefined
          ? createDefaultMaterial(this.cache)
          : this.getDependency('material', primitives[i].material)

      pending.push(material)
    }

    pending.push(parser.loadGeometries(primitives))

    return Promise.all(pending).then(function (results) {
      const materials = results.slice(0, results.length - 1)
      const geometries = results[results.length - 1]

      const meshes = []

      for (let i = 0, il = geometries.length; i < il; i++) {
        const geometry = geometries[i]
        const primitive = primitives[i]

        // 1. create Mesh

        let mesh

        const material = materials[i]

        if (
          primitive.mode === WEBGL_CONSTANTS.TRIANGLES ||
          primitive.mode === WEBGL_CONSTANTS.TRIANGLE_STRIP ||
          primitive.mode === WEBGL_CONSTANTS.TRIANGLE_FAN ||
          primitive.mode === undefined
        ) {
          // .isSkinnedMesh isn't in glTF spec. See ._markDefs()
          mesh = meshDef.isSkinnedMesh === true ? new SkinnedMesh(geometry, material) : new Mesh(geometry, material)

          if (mesh.isSkinnedMesh === true && !mesh.geometry.attributes.skinWeight.normalized) {
            // we normalize floating point skin weight array to fix malformed assets (see #15319)
            // it's important to skip this for non-float32 data since normalizeSkinWeights assumes non-normalized inputs
            mesh.normalizeSkinWeights()
          }

          if (primitive.mode === WEBGL_CONSTANTS.TRIANGLE_STRIP) {
            mesh.geometry = toTrianglesDrawMode(mesh.geometry, TriangleStripDrawMode)
          } else if (primitive.mode === WEBGL_CONSTANTS.TRIANGLE_FAN) {
            mesh.geometry = toTrianglesDrawMode(mesh.geometry, TriangleFanDrawMode)
          }
        } else if (primitive.mode === WEBGL_CONSTANTS.LINES) {
          mesh = new LineSegments(geometry, material)
        } else if (primitive.mode === WEBGL_CONSTANTS.LINE_STRIP) {
          mesh = new Line(geometry, material)
        } else if (primitive.mode === WEBGL_CONSTANTS.LINE_LOOP) {
          mesh = new LineLoop(geometry, material)
        } else if (primitive.mode === WEBGL_CONSTANTS.POINTS) {
          mesh = new Points(geometry, material)
        } else {
          throw new Error('THREE.GLTFLoader: Primitive mode unsupported: ' + primitive.mode)
        }

        if (Object.keys(mesh.geometry.morphAttributes).length > 0) {
          updateMorphTargets(mesh, meshDef)
        }

        mesh.name = parser.createUniqueName(meshDef.name || 'mesh_' + meshIndex)

        assignExtrasToUserData(mesh, meshDef)

        if (primitive.extensions) addUnknownExtensionsToUserData(extensions, mesh, primitive)

        parser.assignFinalMaterial(mesh)

        meshes.push(mesh)
      }

      if (meshes.length === 1) {
        return meshes[0]
      }

      const group = new Group()

      for (let i = 0, il = meshes.length; i < il; i++) {
        group.add(meshes[i])
      }

      return group
    })
  }

  /**
   * Specification: https://github.com/KhronosGroup/glTF/tree/master/specification/2.0#cameras
   * @param {number} cameraIndex
   * @return {Promise<THREE.Camera>}
   */
  loadCamera(cameraIndex) {
    let camera
    const cameraDef = this.json.cameras[cameraIndex]
    const params = cameraDef[cameraDef.type]

    if (!params) {
      console.warn('THREE.GLTFLoader: Missing camera parameters.')
      return
    }

    if (cameraDef.type === 'perspective') {
      camera = new PerspectiveCamera(
        MathUtils.radToDeg(params.yfov),
        params.aspectRatio || 1,
        params.znear || 1,
        params.zfar || 2e6,
      )
    } else if (cameraDef.type === 'orthographic') {
      camera = new OrthographicCamera(-params.xmag, params.xmag, params.ymag, -params.ymag, params.znear, params.zfar)
    }

    if (cameraDef.name) camera.name = this.createUniqueName(cameraDef.name)

    assignExtrasToUserData(camera, cameraDef)

    return Promise.resolve(camera)
  }

  /**
   * Specification: https://github.com/KhronosGroup/glTF/tree/master/specification/2.0#skins
   * @param {number} skinIndex
   * @return {Promise<Object>}
   */
  loadSkin(skinIndex) {
    const skinDef = this.json.skins[skinIndex]

    const skinEntry = { joints: skinDef.joints }

    if (skinDef.inverseBindMatrices === undefined) {
      return Promise.resolve(skinEntry)
    }

    return this.getDependency('accessor', skinDef.inverseBindMatrices).then(function (accessor) {
      skinEntry.inverseBindMatrices = accessor

      return skinEntry
    })
  }

  /**
   * Specification: https://github.com/KhronosGroup/glTF/tree/master/specification/2.0#animations
   * @param {number} animationIndex
   * @return {Promise<AnimationClip>}
   */
  loadAnimation(animationIndex) {
    const json = this.json

    const animationDef = json.animations[animationIndex]

    const pendingNodes = []
    const pendingInputAccessors = []
    const pendingOutputAccessors = []
    const pendingSamplers = []
    const pendingTargets = []

    for (let i = 0, il = animationDef.channels.length; i < il; i++) {
      const channel = animationDef.channels[i]
      const sampler = animationDef.samplers[channel.sampler]
      const target = channel.target
      const name = target.node !== undefined ? target.node : target.id // NOTE: target.id is deprecated.
      const input = animationDef.parameters !== undefined ? animationDef.parameters[sampler.input] : sampler.input
      const output = animationDef.parameters !== undefined ? animationDef.parameters[sampler.output] : sampler.output

      pendingNodes.push(this.getDependency('node', name))
      pendingInputAccessors.push(this.getDependency('accessor', input))
      pendingOutputAccessors.push(this.getDependency('accessor', output))
      pendingSamplers.push(sampler)
      pendingTargets.push(target)
    }

    return Promise.all([
      Promise.all(pendingNodes),
      Promise.all(pendingInputAccessors),
      Promise.all(pendingOutputAccessors),
      Promise.all(pendingSamplers),
      Promise.all(pendingTargets),
    ]).then(function (dependencies) {
      const nodes = dependencies[0]
      const inputAccessors = dependencies[1]
      const outputAccessors = dependencies[2]
      const samplers = dependencies[3]
      const targets = dependencies[4]

      const tracks = []

      for (let i = 0, il = nodes.length; i < il; i++) {
        const node = nodes[i]
        const inputAccessor = inputAccessors[i]
        const outputAccessor = outputAccessors[i]
        const sampler = samplers[i]
        const target = targets[i]

        if (node === undefined) continue

        node.updateMatrix()
        node.matrixAutoUpdate = true

        let TypedKeyframeTrack

        switch (PATH_PROPERTIES[target.path]) {
          case PATH_PROPERTIES.weights:
            TypedKeyframeTrack = NumberKeyframeTrack
            break

          case PATH_PROPERTIES.rotation:
            TypedKeyframeTrack = QuaternionKeyframeTrack
            break

          case PATH_PROPERTIES.position:
          case PATH_PROPERTIES.scale:
          default:
            TypedKeyframeTrack = VectorKeyframeTrack
            break
        }

        const targetName = node.name ? node.name : node.uuid

        const interpolation =
          sampler.interpolation !== undefined ? INTERPOLATION[sampler.interpolation] : InterpolateLinear

        const targetNames = []

        if (PATH_PROPERTIES[target.path] === PATH_PROPERTIES.weights) {
          // Node may be a Group (glTF mesh with several primitives) or a Mesh.
          node.traverse(function (object) {
            if (object.isMesh === true && object.morphTargetInfluences) {
              targetNames.push(object.name ? object.name : object.uuid)
            }
          })
        } else {
          targetNames.push(targetName)
        }

        let outputArray = outputAccessor.array

        if (outputAccessor.normalized) {
          const scale = getNormalizedComponentScale(outputArray.constructor)
          const scaled = new Float32Array(outputArray.length)

          for (let j = 0, jl = outputArray.length; j < jl; j++) {
            scaled[j] = outputArray[j] * scale
          }

          outputArray = scaled
        }

        for (let j = 0, jl = targetNames.length; j < jl; j++) {
          const track = new TypedKeyframeTrack(
            targetNames[j] + '.' + PATH_PROPERTIES[target.path],
            inputAccessor.array,
            outputArray,
            interpolation,
          )

          // Override interpolation with custom factory method.
          if (sampler.interpolation === 'CUBICSPLINE') {
            track.createInterpolant = function InterpolantFactoryMethodGLTFCubicSpline(result) {
              // A CUBICSPLINE keyframe in glTF has three output values for each input value,
              // representing inTangent, splineVertex, and outTangent. As a result, track.getValueSize()
              // must be divided by three to get the interpolant's sampleSize argument.

              return new GLTFCubicSplineInterpolant(this.times, this.values, this.getValueSize() / 3, result)
            }

            // Mark as CUBICSPLINE. `track.getInterpolation()` doesn't support custom interpolants.
            track.createInterpolant.isInterpolantFactoryMethodGLTFCubicSpline = true
          }

          tracks.push(track)
        }
      }

      const name = animationDef.name ? animationDef.name : 'animation_' + animationIndex

      return new AnimationClip(name, undefined, tracks)
    })
  }

  createNodeMesh(nodeIndex) {
    const json = this.json
    const parser = this
    const nodeDef = json.nodes[nodeIndex]

    if (nodeDef.mesh === undefined) return null

    return parser.getDependency('mesh', nodeDef.mesh).then(function (mesh) {
      const node = parser._getNodeRef(parser.meshCache, nodeDef.mesh, mesh)

      // if weights are provided on the node, override weights on the mesh.
      if (nodeDef.weights !== undefined) {
        node.traverse(function (o) {
          if (!o.isMesh) return

          for (let i = 0, il = nodeDef.weights.length; i < il; i++) {
            o.morphTargetInfluences[i] = nodeDef.weights[i]
          }
        })
      }

      return node
    })
  }

  /**
   * Specification: https://github.com/KhronosGroup/glTF/tree/master/specification/2.0#nodes-and-hierarchy
   * @param {number} nodeIndex
   * @return {Promise<Object3D>}
   */
  loadNode(nodeIndex) {
    const json = this.json
    const extensions = this.extensions
    const parser = this

    const nodeDef = json.nodes[nodeIndex]

    // reserve node's name before its dependencies, so the root has the intended name.
    const nodeName = nodeDef.name ? parser.createUniqueName(nodeDef.name) : ''

    return (function () {
      const pending = []

      const meshPromise = parser._invokeOne(function (ext) {
        return ext.createNodeMesh && ext.createNodeMesh(nodeIndex)
      })

      if (meshPromise) {
        pending.push(meshPromise)
      }

      if (nodeDef.camera !== undefined) {
        pending.push(
          parser.getDependency('camera', nodeDef.camera).then(function (camera) {
            return parser._getNodeRef(parser.cameraCache, nodeDef.camera, camera)
          }),
        )
      }

      parser
        ._invokeAll(function (ext) {
          return ext.createNodeAttachment && ext.createNodeAttachment(nodeIndex)
        })
        .forEach(function (promise) {
          pending.push(promise)
        })

      return Promise.all(pending)
    })().then(function (objects) {
      let node

      // .isBone isn't in glTF spec. See ._markDefs
      if (nodeDef.isBone === true) {
        node = new Bone()
      } else if (objects.length > 1) {
        node = new Group()
      } else if (objects.length === 1) {
        node = objects[0]
      } else {
        node = new Object3D()
      }

      if (node !== objects[0]) {
        for (let i = 0, il = objects.length; i < il; i++) {
          node.add(objects[i])
        }
      }

      if (nodeDef.name) {
        node.userData.name = nodeDef.name
        node.name = nodeName
      }

      assignExtrasToUserData(node, nodeDef)

      if (nodeDef.extensions) addUnknownExtensionsToUserData(extensions, node, nodeDef)

      if (nodeDef.matrix !== undefined) {
        const matrix = new Matrix4()
        matrix.fromArray(nodeDef.matrix)
        node.applyMatrix4(matrix)
      } else {
        if (nodeDef.translation !== undefined) {
          node.position.fromArray(nodeDef.translation)
        }

        if (nodeDef.rotation !== undefined) {
          node.quaternion.fromArray(nodeDef.rotation)
        }

        if (nodeDef.scale !== undefined) {
          node.scale.fromArray(nodeDef.scale)
        }
      }

      parser.associations.set(node, { type: 'nodes', index: nodeIndex })

      return node
    })
  }

  /**
   * Specification: https://github.com/KhronosGroup/glTF/tree/master/specification/2.0#scenes
   * @param {number} sceneIndex
   * @return {Promise<Group>}
   */
  loadScene(sceneIndex) {
    const json = this.json
    const extensions = this.extensions
    const sceneDef = this.json.scenes[sceneIndex]
    const parser = this

    // Loader returns Group, not Scene.
    // See: https://github.com/mrdoob/three.js/issues/18342#issuecomment-578981172
    const scene = new Group()
    if (sceneDef.name) scene.name = parser.createUniqueName(sceneDef.name)

    assignExtrasToUserData(scene, sceneDef)

    if (sceneDef.extensions) addUnknownExtensionsToUserData(extensions, scene, sceneDef)

    const nodeIds = sceneDef.nodes || []

    const pending = []

    for (let i = 0, il = nodeIds.length; i < il; i++) {
      pending.push(buildNodeHierachy(nodeIds[i], scene, json, parser))
    }

    return Promise.all(pending).then(function () {
      return scene
    })
  }
}
