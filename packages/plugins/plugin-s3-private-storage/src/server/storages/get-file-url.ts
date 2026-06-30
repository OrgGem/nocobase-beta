type FileRecordLike = {
  id?: string | number;
  constructor?: {
    name?: string;
    collection?: {
      name?: string;
    };
  };
};

export function getPrivateS3StreamCollectionName(file: FileRecordLike) {
  return file.constructor?.name === 'aiFiles' ? 'aiFiles' : file.constructor?.collection?.name || 'attachments';
}

export function getPrivateS3StreamUrl(file: FileRecordLike, preview?: boolean) {
  const fileId = file.id;
  if (!fileId) {
    return '';
  }
  const collectionName = getPrivateS3StreamCollectionName(file);
  const mode = preview ? 'inline' : 'attachment';
  return `/api/attachments:stream?filterByTk=${fileId}&mode=${mode}&collection=${collectionName}`;
}
