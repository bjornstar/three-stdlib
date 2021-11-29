import { GLTFExtension } from "./GLTFExtension"

/**
 * Mesh Quantization Extension
 *
 * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_mesh_quantization
 */

export class GLTFMeshQuantizationExtension extends GLTFExtension{
  readonly name!: 'KHR_mesh_quantization'

  constructor() {
    super('KHR_mesh_quantization')
  }
}
