import path from 'node:path';
export class MetadataExtractor {
    extract(filename, sizeBytes) {
        const base = path.basename(filename);
        const extension = path.extname(base).toLowerCase();
        return {
            filename: base,
            extension,
            sizeBytes: Math.max(0, Number(sizeBytes) || 0),
        };
    }
}
