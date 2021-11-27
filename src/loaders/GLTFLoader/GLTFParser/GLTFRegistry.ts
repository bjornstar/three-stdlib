type AnyObject = { [key: PropertyKey]: unknown }

export function GLTFRegistry() {
  let objects: AnyObject = {}

  return {
    get: function (key: PropertyKey) {
      return objects[key]
    },

    add: function (key: PropertyKey, object: AnyObject) {
      objects[key] = object
    },

    remove: function (key: PropertyKey) {
      delete objects[key]
    },

    removeAll: function () {
      objects = {}
    },
  }
}
