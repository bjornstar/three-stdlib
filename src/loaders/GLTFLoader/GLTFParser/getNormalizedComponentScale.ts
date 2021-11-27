// Reference:
// https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_mesh_quantization#encoding-quantized-data

export function getNormalizedComponentScale(constructor: typeof Int8Array | typeof Uint8Array | typeof Int16Array | typeof Uint16Array): number {
  switch (constructor) {
    case Int8Array:
      return 1 / 127

    case Uint8Array:
      return 1 / 255

    case Int16Array:
      return 1 / 32767

    case Uint16Array:
      return 1 / 65535

    default:
      throw new Error('THREE.GLTFLoader: Unsupported normalized accessor component type.')
  }
}
