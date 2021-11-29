import { Color, MeshPhysicalMaterial } from "three"

/**
 * Materials specular Extension
 *
 * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_materials_specular
 */

export class GLTFMaterialsSpecularExtension {
  constructor(parser) {
    this.parser = parser
    this.name = EXTENSIONS.KHR_MATERIALS_SPECULAR
  }

  getMaterialType(materialIndex) {
    const parser = this.parser
    const materialDef = parser.json.materials[materialIndex]

    if (!materialDef.extensions || !materialDef.extensions[this.name]) return null

    return MeshPhysicalMaterial
  }

  extendMaterialParams(materialIndex, materialParams) {
    const parser = this.parser
    const materialDef = parser.json.materials[materialIndex]

    if (!materialDef.extensions || !materialDef.extensions[this.name]) {
      return Promise.resolve()
    }

    const pending = []

    const extension = materialDef.extensions[this.name]

    materialParams.specularIntensity = extension.specularFactor !== undefined ? extension.specularFactor : 1.0

    if (extension.specularTexture !== undefined) {
      pending.push(parser.assignTexture(materialParams, 'specularIntensityMap', extension.specularTexture))
    }

    const colorArray = extension.specularColorFactor || [1, 1, 1]
    materialParams.specularTint = new Color(colorArray[0], colorArray[1], colorArray[2])

    if (extension.specularColorTexture !== undefined) {
      pending.push(
        parser
          .assignTexture(materialParams, 'specularTintMap', extension.specularColorTexture)
          .then(function (texture) {
            texture.encoding = sRGBEncoding
          }),
      )
    }

    return Promise.all(pending)
  }
}
