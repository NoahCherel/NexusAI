// API Key encryption using Web Crypto API (AES-GCM)
// Keys are stored encrypted in localStorage, never sent to our servers

const ENCRYPTION_KEY_NAME = 'nexusai-master-key';
const DB_NAME = 'nexusai-crypto';
const STORE_NAME = 'keys';

async function openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = (event) => {
            const db = (event.target as IDBOpenDBRequest).result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
    });
}

async function getStoredKey(): Promise<CryptoKey | null> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.get(ENCRYPTION_KEY_NAME);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result || null);
    });
}

async function storeKey(key: CryptoKey): Promise<void> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const request = store.put(key, ENCRYPTION_KEY_NAME);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve();
    });
}

async function getOrCreateKey(): Promise<CryptoKey> {
    let key = await getStoredKey();
    if (!key) {
        key = await crypto.subtle.generateKey(
            { name: 'AES-GCM', length: 256 },
            false, // not extractable for security
            ['encrypt', 'decrypt']
        );
        await storeKey(key);
    }
    return key;
}

export async function encryptApiKey(apiKey: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(apiKey);

    const key = await getOrCreateKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));

    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);

    // Combine IV + encrypted data and encode as base64
    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(encrypted), iv.length);

    return btoa(String.fromCharCode(...combined));
}

export async function decryptApiKey(encryptedKey: string): Promise<string> {
    const key = await getStoredKey();
    if (!key) {
        throw new Error('No encryption key found. Please re-enter your API key.');
    }

    const combined = Uint8Array.from(atob(encryptedKey), (c) => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const encrypted = combined.slice(12);

    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);

    return new TextDecoder().decode(decrypted);
}

export async function validateApiKey(
    provider: 'openrouter' | 'openai' | 'anthropic',
    apiKey: string
): Promise<boolean> {
    try {
        const response = await fetch('/api/validate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider, apiKey }),
        });

        if (!response.ok) return false;
        const data = await response.json();
        return data.isValid;
    } catch {
        return false;
    }
}
