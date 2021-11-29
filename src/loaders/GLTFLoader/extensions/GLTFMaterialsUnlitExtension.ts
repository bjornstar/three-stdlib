import { Color, MeshBasicMaterial } from 'three'

import { EXTENSIONS } from './extensions'

/**
 * Unlit Materials Extension
 *
 * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_materials_unlit
 */

export class GLTFMaterialsUnlitExtension {
  constructor() {
    this.name = EXTENSIONS.KHR_MATERIALS_UNLIT
  }

  getMaterialType() {
    return MeshBasicMaterial
  }

  extendParams(materialParams, materialDef, parser) {
    const pending = []

    materialParams.color = new Color(1.0, 1.0, 1.0)
    materialParams.opacity = 1.0

    const metallicRoughness = materialDef.pbrMetallicRoughness

    if (metallicRoughness) {
      if (Array.isArray(metallicRoughness.baseColorFactor)) {
        const array = metallicRoughness.baseColorFactor

        materialParams.color.fromArray(array)
        materialParams.opacity = array[3]
      }

      if (metallicRoughness.baseColorTexture !== undefined) {
        pending.push(parser.assignTexture(materialParams, 'map', metallicRoughness.baseColorTexture))
      }
    }

    return Promise.all(pending)
  }
}
