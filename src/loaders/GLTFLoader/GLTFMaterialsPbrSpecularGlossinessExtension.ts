import { Color, TangentSpaceNormalMap } from 'three'

import { GLTFMeshStandardSGMaterial } from './GLTFMeshStandardSGMaterial'

export class GLTFMaterialsPbrSpecularGlossinessExtension {
  name: 'KHR_materials_pbrSpecularGlossiness'

  constructor() {
    this.name = 'KHR_materials_pbrSpecularGlossiness'

    this.specularGlossinessParams = [
      'color',
      'map',
      'lightMap',
      'lightMapIntensity',
      'aoMap',
      'aoMapIntensity',
      'emissive',
      'emissiveIntensity',
      'emissiveMap',
      'bumpMap',
      'bumpScale',
      'normalMap',
      'normalMapType',
      'displacementMap',
      'displacementScale',
      'displacementBias',
      'specularMap',
      'specular',
      'glossinessMap',
      'glossiness',
      'alphaMap',
      'envMap',
      'envMapIntensity',
      'refractionRatio',
    ]
  }

  getMaterialType() {
    return GLTFMeshStandardSGMaterial
  }

  extendParams(materialParams, materialDef, parser) {
    const pbrSpecularGlossiness = materialDef.extensions[this.name]

    materialParams.color = new Color(1.0, 1.0, 1.0)
    materialParams.opacity = 1.0

    const pending = []

    if (Array.isArray(pbrSpecularGlossiness.diffuseFactor)) {
      const array = pbrSpecularGlossiness.diffuseFactor

      materialParams.color.fromArray(array)
      materialParams.opacity = array[3]
    }

    if (pbrSpecularGlossiness.diffuseTexture !== undefined) {
      pending.push(parser.assignTexture(materialParams, 'map', pbrSpecularGlossiness.diffuseTexture))
    }

    materialParams.emissive = new Color(0.0, 0.0, 0.0)
    materialParams.glossiness =
      pbrSpecularGlossiness.glossinessFactor !== undefined ? pbrSpecularGlossiness.glossinessFactor : 1.0
    materialParams.specular = new Color(1.0, 1.0, 1.0)

    if (Array.isArray(pbrSpecularGlossiness.specularFactor)) {
      materialParams.specular.fromArray(pbrSpecularGlossiness.specularFactor)
    }

    if (pbrSpecularGlossiness.specularGlossinessTexture !== undefined) {
      const specGlossMapDef = pbrSpecularGlossiness.specularGlossinessTexture
      pending.push(parser.assignTexture(materialParams, 'glossinessMap', specGlossMapDef))
      pending.push(parser.assignTexture(materialParams, 'specularMap', specGlossMapDef))
    }

    return Promise.all(pending)
  }

  createMaterial(materialParams) {
    const material = new GLTFMeshStandardSGMaterial(materialParams)
    material.fog = true

    material.color = materialParams.color

    material.map = materialParams.map === undefined ? null : materialParams.map

    material.lightMap = null
    material.lightMapIntensity = 1.0

    material.aoMap = materialParams.aoMap === undefined ? null : materialParams.aoMap
    material.aoMapIntensity = 1.0

    material.emissive = materialParams.emissive
    material.emissiveIntensity = 1.0
    material.emissiveMap = materialParams.emissiveMap === undefined ? null : materialParams.emissiveMap

    material.bumpMap = materialParams.bumpMap === undefined ? null : materialParams.bumpMap
    material.bumpScale = 1

    material.normalMap = materialParams.normalMap === undefined ? null : materialParams.normalMap
    material.normalMapType = TangentSpaceNormalMap

    if (materialParams.normalScale) material.normalScale = materialParams.normalScale

    material.displacementMap = null
    material.displacementScale = 1
    material.displacementBias = 0

    material.specularMap = materialParams.specularMap === undefined ? null : materialParams.specularMap
    material.specular = materialParams.specular

    material.glossinessMap = materialParams.glossinessMap === undefined ? null : materialParams.glossinessMap
    material.glossiness = materialParams.glossiness

    material.alphaMap = null

    material.envMap = materialParams.envMap === undefined ? null : materialParams.envMap
    material.envMapIntensity = 1.0

    material.refractionRatio = 0.98

    return material
  }
}
