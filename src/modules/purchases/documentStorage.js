// The domain passes only an opaque document id and bytes to this adapter. It
// never constructs filesystem paths or exposes permanent/public storage URLs.
// Every method receives the current transaction client. A future object-storage
// adapter must preserve the atomic contract (staging/compensation and retries),
// not silently leave a document missing or orphan a file when a transaction fails.
export const postgresPurchaseDocumentStorage = Object.freeze({
  async save(database, { documentId, content }) {
    await database.purchaseDocumentContent.create({ data: { documentId, content } });
  },
  async get(database, { documentId }) {
    const stored = await database.purchaseDocumentContent.findUnique({
      where: { documentId }, select: { content: true },
    });
    return stored ? Buffer.from(stored.content) : null;
  },
  async delete(database, { documentId }) {
    // A missing binary is an integrity failure, not a successful delete.
    await database.purchaseDocumentContent.delete({ where: { documentId } });
  },
});
