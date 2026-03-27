export function centroid(vectors) {
    if (vectors.length === 0)
        throw new Error('No vectors');
    const dim = vectors[0].length;
    const sums = new Array(dim).fill(0);
    for (const vec of vectors) {
        if (vec.length !== dim)
            throw new Error('Vector dimensions mismatch');
        for (let i = 0; i < dim; i++)
            sums[i] += vec[i];
    }
    return sums.map((s) => s / vectors.length);
}
