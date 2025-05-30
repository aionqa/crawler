import path from 'path';
import { URL } from 'url';

export function getSafeFolderPath(urlStr) {
    const { protocol, hostname, pathname } = new URL(urlStr);
    const parts = [protocol.replace(':', ''), hostname, ...pathname.split('/').filter(Boolean)];
    const safeParts = parts.map(p => p.replace(/[^a-z0-9]/gi, '_').toLowerCase());
    return path.join('outcome', ...safeParts);
}
