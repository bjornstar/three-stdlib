export function resolveURL(url: unknown, path: string) {
  // Invalid URL
  if (typeof url !== 'string' || url === '') return ''

  // Host Relative URL
  if (/^https?:\/\//i.test(path) && /^\//.test(url)) {
    path = path.replace(/(^https?:\/\/[^\/]+).*/i, '$1')
  }

  // Absolute URL http://,https://,//
  if (/^(https?:)?\/\//i.test(url)) return url

  // Data URI
  if (/^data:.*,.*$/i.test(url)) return url

  // Blob URL
  if (/^blob:.*$/i.test(url)) return url

  // Relative URL
  return path + url
}
