// Tagged containers avoid collisions with user-written objects, and preserve Dates
// and old vector/binary records which plain JSON.stringify silently damages.
type Packed = { type: string; value?: unknown; kind?: string };
const typedArrays = {
    Int8Array,
    Uint8Array,
    Uint8ClampedArray,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array,
    BigInt64Array,
    BigUint64Array,
};

export function packBackupValue(value: unknown): Packed {
    if (value === undefined) return { type: 'undefined' };
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
        return { type: 'scalar', value };
    if (typeof value === 'number')
        return { type: 'number', value: Object.is(value, -0) ? '-0' : String(value) };
    if (typeof value === 'bigint') return { type: 'bigint', value: String(value) };
    if (value instanceof Date) return { type: 'date', value: value.toISOString() };
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        const bytes =
            value instanceof ArrayBuffer
                ? new Uint8Array(value)
                : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        let binary = '';
        for (let i = 0; i < bytes.length; i += 8192)
            binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        return { type: 'binary', kind: value.constructor.name, value: btoa(binary) };
    }
    if (Array.isArray(value)) return { type: 'array', value: value.map(packBackupValue) };
    if (value instanceof Map)
        return {
            type: 'map',
            value: [...value].map(([k, v]) => [packBackupValue(k), packBackupValue(v)]),
        };
    if (value instanceof Set) return { type: 'set', value: [...value].map(packBackupValue) };
    if (
        typeof value === 'object' &&
        (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    ) {
        return {
            type: 'object',
            value: Object.entries(value).map(([key, item]) => [key, packBackupValue(item)]),
        };
    }
    throw new Error(
        'Un type de donnée ne peut pas être sauvegardé. Aucun export incomplet ne sera téléchargé.'
    );
}

export function unpackBackupValue(input: unknown): unknown {
    if (!input || typeof input !== 'object') throw new Error('Donnée de sauvegarde invalide.');
    const { type, value, kind } = input as Packed;
    switch (type) {
        case 'undefined':
            return undefined;
        case 'scalar':
            if (value === null || typeof value === 'string' || typeof value === 'boolean')
                return value;
            break;
        case 'number':
            if (
                typeof value === 'string' &&
                (value === 'NaN' || String(Number(value)) === value || value === '-0')
            )
                return Number(value);
            break;
        case 'bigint':
            if (typeof value === 'string') return BigInt(value);
            break;
        case 'date':
            if (typeof value === 'string' && Number.isFinite(Date.parse(value)))
                return new Date(value);
            break;
        case 'array':
            if (Array.isArray(value)) return value.map(unpackBackupValue);
            break;
        case 'set':
            if (Array.isArray(value)) return new Set(value.map(unpackBackupValue));
            break;
        case 'object':
        case 'map':
            if (
                Array.isArray(value) &&
                value.every((entry) => Array.isArray(entry) && entry.length === 2)
            ) {
                if (type === 'object' && value.every(([key]) => typeof key === 'string')) {
                    return Object.fromEntries(
                        value.map(([key, item]) => [key, unpackBackupValue(item)])
                    );
                }
                if (type === 'map')
                    return new Map(
                        value.map(([key, item]) => [
                            unpackBackupValue(key),
                            unpackBackupValue(item),
                        ])
                    );
            }
            break;
        case 'binary':
            if (typeof value === 'string') {
                const buffer = Uint8Array.from(atob(value), (char) => char.charCodeAt(0)).buffer;
                if (kind === 'ArrayBuffer') return buffer;
                if (kind === 'DataView') return new DataView(buffer);
                if (kind && Object.hasOwn(typedArrays, kind))
                    return new typedArrays[kind as keyof typeof typedArrays](buffer);
            }
    }
    throw new Error('Donnée de sauvegarde invalide ou format non pris en charge.');
}
