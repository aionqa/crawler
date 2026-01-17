/**
 * Import Verification Tests for Unified Crawler
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve, join, extname } from 'path';
import { glob } from 'glob';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '../../..');
const crawlerSrcRoot = resolve(__dirname, '..');

function resolveImportPath(importPath, fromFile) {
  const fromDir = dirname(fromFile);
  
  if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
    return { type: 'external', path: importPath };
  }
  
  let resolvedPath = resolve(fromDir, importPath);
  
  if (!extname(resolvedPath)) {
    const withJs = resolvedPath + '.js';
    if (existsSync(withJs)) {
      return { type: 'file', path: withJs };
    }
    
    const withIndex = join(resolvedPath, 'index.js');
    if (existsSync(withIndex)) {
      return { type: 'file', path: withIndex };
    }
  }
  
  if (existsSync(resolvedPath)) {
    return { type: 'file', path: resolvedPath };
  }
  
  if (existsSync(resolvedPath + '.js')) {
    return { type: 'file', path: resolvedPath + '.js' };
  }
  
  return { type: 'not-found', path: resolvedPath };
}

function extractImports(content) {
  const imports = [];
  
  const es6ImportRegex = /import\s+(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]/g;
  let match;
  while ((match = es6ImportRegex.exec(content)) !== null) {
    imports.push({
      type: 'es6',
      path: match[1],
      line: content.substring(0, match.index).split('\n').length
    });
  }
  
  const dynamicImportRegex = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = dynamicImportRegex.exec(content)) !== null) {
    imports.push({
      type: 'dynamic',
      path: match[1],
      line: content.substring(0, match.index).split('\n').length
    });
  }
  
  return imports;
}

describe('Unified Crawler Import Verification', () => {
  let files = [];
  
  beforeAll(async () => {
    const patterns = ['unified-crawler/src/**/*.js'];
    for (const pattern of patterns) {
      const matches = await glob(pattern, { cwd: projectRoot, absolute: true });
      files.push(...matches.filter(f => !f.includes('__tests__')));
    }
  });
  
  it('should find files to test', () => {
    expect(files.length).toBeGreaterThan(0);
  });
  
  describe.each(files.map(f => [f]))('File: %s', (filePath) => {
    it('should have all imports resolve', () => {
      const content = readFileSync(filePath, 'utf-8');
      const imports = extractImports(content);
      
      const failures = [];
      
      for (const imp of imports) {
        if (!imp.path.startsWith('.') && !imp.path.startsWith('/')) {
          continue;
        }
        
        const resolved = resolveImportPath(imp.path, filePath);
        
        if (resolved.type === 'not-found') {
          failures.push({
            import: imp.path,
            line: imp.line,
            error: `Cannot resolve: ${imp.path} (tried: ${resolved.path})`
          });
        }
      }
      
      if (failures.length > 0) {
        const errorMsg = failures.map(f => 
          `  Line ${f.line}: ${f.import}\n    ${f.error}`
        ).join('\n');
        throw new Error(`Import errors in ${filePath}:\n${errorMsg}`);
      }
    });
  });
});












































