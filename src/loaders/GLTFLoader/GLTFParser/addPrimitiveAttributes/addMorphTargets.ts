import type { BufferGeometry } from 'three'

import type { GLTFParser } from '../index'

/**
 * Specification: https://github.com/KhronosGroup/glTF/blob/master/specification/2.0/README.md#morph-targets
 *
 * @param {BufferGeometry} geometry
 * @param {Array<GLTF.Target>} targets
 * @param {GLTFParser} parser
 * @return {Promise<BufferGeometry>}
 */

export function addMorphTargets(geometry: BufferGeometry, targets: unknown[], parser: GLTFParser): Promise<BufferGeometry> {
  let hasMorphPosition = false
  let hasMorphNormal = false

  for (let i = 0, il = targets.length; i < il; i++) {
    const target = targets[i]

    if (target.POSITION !== undefined) hasMorphPosition = true
    if (target.NORMAL !== undefined) hasMorphNormal = true

    if (hasMorphPosition && hasMorphNormal) break
  }

  if (!hasMorphPosition && !hasMorphNormal) return Promise.resolve(geometry)

  const pendingPositionAccessors = []
  const pendingNormalAccessors = []

  for (let i = 0, il = targets.length; i < il; i++) {
    const target = targets[i]

    if (hasMorphPosition) {
      const pendingAccessor =
        target.POSITION !== undefined ? parser.getDependency('accessor', target.POSITION) : geometry.attributes.position

      pendingPositionAccessors.push(pendingAccessor)
    }

    if (hasMorphNormal) {
      const pendingAccessor =
        target.NORMAL !== undefined ? parser.getDependency('accessor', target.NORMAL) : geometry.attributes.normal

      pendingNormalAccessors.push(pendingAccessor)
    }
  }

  return Promise.all([Promise.all(pendingPositionAccessors), Promise.all(pendingNormalAccessors)]).then(function (
    accessors,
  ) {
    const morphPositions = accessors[0]
    const morphNormals = accessors[1]

    if (hasMorphPosition) geometry.morphAttributes.position = morphPositions
    if (hasMorphNormal) geometry.morphAttributes.normal = morphNormals
    geometry.morphTargetsRelative = true

    return geometry
  })
}
