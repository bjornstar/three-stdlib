import { MeshPhysicalMaterial } from 'three'

/**
 * Materials ior Extension
 *
 * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_materials_ior
 */

export class GLTFMaterialsIorExtension {
  name: 'KHR_materials_ior'

  constructor(parser) {
    this.parser = parser
    this.name = 'KHR_materials_ior'
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

    const extension = materialDef.extensions[this.name]

    materialParams.ior = extension.ior !== undefined ? extension.ior : 1.5

    return Promise.resolve()
  }
}
