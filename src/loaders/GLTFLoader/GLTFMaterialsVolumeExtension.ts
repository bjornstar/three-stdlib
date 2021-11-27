import { Color, MeshPhysicalMaterial } from 'three'

/**
 * Materials Volume Extension
 *
 * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_materials_volume
 */

export class GLTFMaterialsVolumeExtension {
  constructor(parser) {
    this.parser = parser
    this.name = EXTENSIONS.KHR_MATERIALS_VOLUME
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

    materialParams.thickness = extension.thicknessFactor !== undefined ? extension.thicknessFactor : 0

    if (extension.thicknessTexture !== undefined) {
      pending.push(parser.assignTexture(materialParams, 'thicknessMap', extension.thicknessTexture))
    }

    materialParams.attenuationDistance = extension.attenuationDistance || 0

    const colorArray = extension.attenuationColor || [1, 1, 1]
    materialParams.attenuationTint = new Color(colorArray[0], colorArray[1], colorArray[2])

    return Promise.all(pending)
  }
}
