export const MODERN_MANIFEST_ACCEPT = [
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.oci.image.index.v1+json',
].join(', ');

export const MANIFEST_ACCEPT = [MODERN_MANIFEST_ACCEPT, 'application/vnd.docker.distribution.manifest.v1+json'].join(
  ', ',
);

export const DOCKER_MANIFEST_LIST = 'application/vnd.docker.distribution.manifest.list.v2+json';
export const OCI_IMAGE_INDEX = 'application/vnd.oci.image.index.v1+json';
