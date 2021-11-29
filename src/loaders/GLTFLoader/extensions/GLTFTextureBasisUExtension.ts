/**
 * BasisU Texture Extension
 *
 * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_texture_basisu
 */

export class GLTFTextureBasisUExtension {
  name: 'KHR_texture_basisu'
  constructor(parser) {
    this.parser = parser
    this.name = 'KHR_texture_basisu'
  }

  loadTexture(textureIndex) {
    const parser = this.parser
    const json = parser.json

    const textureDef = json.textures[textureIndex]

    if (!textureDef.extensions || !textureDef.extensions[this.name]) {
      return null
    }

    const extension = textureDef.extensions[this.name]
    const source = json.images[extension.source]
    const loader = parser.options.ktx2Loader

    if (!loader) {
      if (json.extensionsRequired && json.extensionsRequired.indexOf(this.name) >= 0) {
        throw new Error('THREE.GLTFLoader: setKTX2Loader must be called before loading KTX2 textures')
      } else {
        // Assumes that the extension is optional and that a fallback texture is present
        return null
      }
    }

    return parser.loadTextureImage(textureIndex, source, loader)
  }
}
