#!/usr/bin/env node

// -----------------------------------------------------------------------------
// 本地 NPM 包 API 分析器 (V3 - 带条目列举)
//
// 用法: node analyze.js <path-to-local-package>
// 示例: node analyze.js ../my-project/
// -----------------------------------------------------------------------------

import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { glob } from 'glob';
import { parse as babelParse } from '@babel/parser';
import babelTraverse from '@babel/traverse';
import doctrine from 'doctrine';
import ts from 'typescript';

// -----------------------------------------------------------------------------
// 辅助工具
// -----------------------------------------------------------------------------

/**
 * 检查 AST 节点是否有有效的 JSDoc 注释。
 */
function hasValidJSDoc(node) {
    const comments = node?.leadingComments;
    if (!comments || comments.length === 0) {
        return false;
    }

    const lastComment = comments[comments.length - 1];
    if (lastComment.type !== 'CommentBlock' || !lastComment.value.startsWith('*')) {
        return false;
    }

    try {
        const doc = doctrine.parse(`/*${lastComment.value}*/`, { unwrap: true });
        return doc.description.length > 0 || doc.tags.length > 0;
    } catch (e) {
        return false;
    }
}

/**
 * 安全地读取文件，如果文件不存在则返回 null。
 */
async function safeReadFile(filePath) {
    try {
        return await fs.readFile(filePath, 'utf-8');
    } catch (e) {
        return null;
    }
}

// -----------------------------------------------------------------------------
// 核心分析器
// -----------------------------------------------------------------------------

/**
 * 1. 分析 JS 导出 (使用 Babel)
 */
async function parseJsExports(filePath, results) {
    const code = await safeReadFile(filePath);
    if (!code) {
        results.errors.push(`Could not read JS entry file: ${filePath}`);
        return;
    }

    let ast;
    try {
        ast = babelParse(code, {
            sourceType: 'module',
            plugins: ['jsx', 'typescript', 'exportDefaultFrom'],
        });
    } catch (e) {
        results.errors.push(`Babel parse error in ${filePath}: ${e.message}`);
        return;
    }

    const traverse = babelTraverse.default;

    traverse(ast, {
        ExportNamedDeclaration(path) {
            if (path.node.source) {
                const reExportSource = path.node.source.value;
                if (!reExportSource.startsWith('.')) {
                    results.reExports.add(reExportSource);
                }
            }

            if (path.node.declaration) {
                const declarations = path.node.declaration.declarations || [path.node.declaration];
                declarations.forEach(decl => {
                    const apiName = decl.id?.name || (decl.id?.type === 'ObjectPattern' ? '[ObjectPattern]' : 'unknown');
                    
                    // --- 变更 ---
                    results.js.list.push(apiName);
                    if (!hasValidJSDoc(path.node)) {
                        results.js.undocumentedList.push(apiName);
                    }
                    // --- 结束变更 ---
                });
            } else if (path.node.specifiers) {
                path.node.specifiers.forEach(spec => {
                    const apiName = spec.exported.name || spec.exported.value;
                    
                    // --- 变更 ---
                    results.js.list.push(apiName);
                    if (!hasValidJSDoc(path.node)) {
                        results.js.undocumentedList.push(apiName);
                    }
                    // --- 结束变更 ---
                });
            }
        },

        ExportAllDeclaration(path) {
            if (path.node.source) {
                const reExportSource = path.node.source.value;
                if (!reExportSource.startsWith('.')) {
                    results.reExports.add(reExportSource);
                }
                // 'export *' 不计入具体 API 列表，因为它太模糊，计入 reExports
            }
        },

        ExportDefaultDeclaration(path) {
            // --- 变更 ---
            const apiName = 'default';
            results.js.list.push(apiName);
            if (!hasValidJSDoc(path.node)) {
                results.js.undocumentedList.push(apiName);
            }
            // --- 结束变更 ---
        },
    });
}

/**
 * 2. 分析 Types 导出 (使用 TypeScript Compiler API)
 */
async function parseTypeExports(filePath, results) {
    if (!filePath || !(await fs.pathExists(filePath))) {
        results.errors.push(`Could not find .d.ts entry file: ${filePath}`);
        return;
    }
    
    let program;
    try {
        program = ts.createProgram([filePath], { allowJs: true, checkJs: false });
    } catch (e) {
        results.errors.push(`TS Program creation failed: ${e.message}`);
        return;
    }
    
    const sourceFile = program.getSourceFile(filePath);
    if (!sourceFile) {
        results.errors.push(`TS SourceFile not found: ${filePath}`);
        return;
    }

    const checker = program.getTypeChecker();
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);

    if (!moduleSymbol) {
        results.errors.push(`Could not find module symbol for: ${filePath}`);
        return;
    }

    const exports = checker.getExportsOfModule(moduleSymbol);
        
    exports.forEach(symbol => {
        if (symbol.name.startsWith('__')) return;

        // --- 变更 ---
        const apiName = symbol.name;
        results.ts.list.push(apiName);
        
        const comments = symbol.getDocumentationComment(checker);
        const hasDocs = comments && comments.length > 0 && !comments.every(c => c.text.trim() === '');
        
        if (!hasDocs) {
            results.ts.undocumentedList.push(apiName);
        }
        // --- 结束变更 ---
    });
}

/**
 * 3. 分析 Module Federation 导出 (使用 Babel)
 */
async function parseMfExports(packageRoot, results) {
    const configFiles = await glob('**/{webpack,webpack.config}.*.{js,mjs,cjs}', {
        cwd: packageRoot,
        ignore: 'node_modules/**',
        absolute: true,
    });

    if (configFiles.length === 0) {
        return;
    }

    const configPath = configFiles[0];
    const code = await safeReadFile(configPath);
    if (!code) {
        results.errors.push(`Could not read Webpack config: ${configPath}`);
        return;
    }

    let ast;
    try {
        ast = babelParse(code, { sourceType: 'module' });
    } catch (e) {
        try {
            ast = babelParse(code, { sourceType: 'script' });
        } catch (e2) {
            results.errors.push(`Babel parse error in ${configPath}: ${e2.message}`);
            return;
        }
    }

    const traverse = babelTraverse.default;
    
    traverse(ast, {
        NewExpression(path) {
            const calleeName = path.node.callee.name;
            if (calleeName && calleeName.includes('ModuleFederationPlugin')) {
                const options = path.node.arguments[0];
                if (options && options.type === 'ObjectExpression') {
                    const exposesProp = options.properties.find(
                        prop => (prop.key.name || prop.key.value) === 'exposes'
                    );

                    if (exposesProp && exposesProp.value.type === 'ObjectExpression') {
                        // --- 变更 ---
                        exposesProp.value.properties.forEach(prop => {
                            // prop.key 可以是 Identifier (name) 或 StringLiteral (value)
                            const apiName = prop.key.name || prop.key.value;
                            if (apiName) {
                                results.mf.list.push(apiName);
                                // MF 导出来源于配置，几乎从不包含 JSDoc
                                results.mf.undocumentedList.push(apiName);
                            }
                        });
                        // --- 结束变更 ---
                    }
                }
            }
        }
    });
}

/**
 * 查找包的入口点
 */
async function findEntryPoints(packageJson, packageRoot) {
    const entryPoints = {
        js: new Set(),
        ts: new Set(),
    };

    if (packageJson.types) {
        entryPoints.ts.add(path.resolve(packageRoot, packageJson.types));
    }
    if (packageJson.main) {
        entryPoints.js.add(path.resolve(packageRoot, packageJson.main));
    }
    if (packageJson.module) {
        entryPoints.js.add(path.resolve(packageRoot, packageJson.module));
    }

    if (packageJson.exports) {
        const exports = packageJson.exports;
        const entries = typeof exports === 'string' ? { '.': exports } : exports;

        for (const [key, value] of Object.entries(entries)) {
            let entry = value;
            if (typeof value === 'object' && value !== null) {
                entry = value.import || value.require || value.default || null;
                if (value.types) {
                    entryPoints.ts.add(path.resolve(packageRoot, value.types));
                }
            }
            
            if (typeof entry === 'string') {
                const ext = path.extname(entry);
                if (ext === '.d.ts') {
                    entryPoints.ts.add(path.resolve(packageRoot, entry));
                } else if (['.js', '.mjs', '.cjs'].includes(ext)) {
                    entryPoints.js.add(path.resolve(packageRoot, entry));
                }
            }
        }
    }
    
    if (entryPoints.ts.size === 0 && entryPoints.js.size > 0) {
        const firstJs = [...entryPoints.js][0];
        const potentialTs = firstJs.replace(/\.js$/, '.d.ts');
        if (await fs.pathExists(potentialTs)) {
            entryPoints.ts.add(potentialTs);
        }
    }

    const filterExists = async (paths) => {
        const checked = await Promise.all([...paths].map(async p => await fs.pathExists(p) ? p : null));
        return new Set(checked.filter(Boolean));
    }
    
    entryPoints.js = await filterExists(entryPoints.js);
    entryPoints.ts = await filterExists(entryPoints.ts);

    return entryPoints;
}

// -----------------------------------------------------------------------------
// 主执行函数
// -----------------------------------------------------------------------------

async function main() {
    const packagePathInput = process.argv[2];
    if (!packagePathInput) {
        console.error('错误: 请提供一个本地包的路径。');
        console.log('用法: node analyze.js <path-to-local-package>');
        process.exit(1);
    }

    const packageRoot = path.resolve(process.cwd(), packagePathInput);
    const packageJsonPath = path.join(packageRoot, 'package.json');

    console.log(`[1/3] 正在分析本地包: ${packageRoot}`);

    if (!(await fs.pathExists(packageJsonPath))) {
        console.error(`错误: 在 ${packageJsonPath} 未找到 package.json。`);
        process.exit(1);
    }

    const packageJson = await fs.readJson(packageJsonPath);
    const packageName = packageJson.name || path.basename(packageRoot);
    
    // --- 变更：初始化 results 结构 ---
    const results = {
        packageName: packageName,
        packagePath: packageRoot,
        js: { total: 0, undocumented: 0, list: [], undocumentedList: [] },
        ts: { total: 0, undocumented: 0, list: [], undocumentedList: [] },
        mf: { total: 0, undocumented: 0, list: [], undocumentedList: [] },
        reExports: new Set(),
        entryPoints: { js: [], ts: [] },
        errors: [],
    };
    // --- 结束变更 ---

    try {
        console.log('[2/3] 正在分析入口点和导出...');
        
        const entryPoints = await findEntryPoints(packageJson, packageRoot);
        results.entryPoints.js = [...entryPoints.js];
        results.entryPoints.ts = [...entryPoints.ts];
        
        if (results.entryPoints.js.length === 0 && results.entryPoints.ts.length === 0) {
            results.errors.push("未能找到任何有效的 JS 或 Typescript 入口文件。");
        }

        for (const jsFile of entryPoints.js) {
            await parseJsExports(jsFile, results);
        }

        for (const tsFile of entryPoints.ts) {
            await parseTypeExports(tsFile, results);
        }

        await parseMfExports(packageRoot, results);

        console.log('[3/3] 分析完成。');

    } catch (e) {
        console.error(`分析过程中发生致命错误: ${e.message}`);
        results.errors.push(e.stack);
    }

    // --- 变更：在报告前去重并更新总数 ---
    const processResults = (key) => {
        const uniqueList = [...new Set(results[key].list)];
        const uniqueUndocumented = [...new Set(results[key].undocumentedList)];
        
        results[key].list = uniqueList;
        results[key].undocumentedList = uniqueUndocumented;
        results[key].total = uniqueList.length;
        results[key].undocumented = uniqueUndocumented.length;
    };

    processResults('js');
    processResults('ts');
    processResults('mf');
    // --- 结束变更 ---

    const finalReport = {
        ...results,
        reExports: [...results.reExports],
    };
    
    console.log('\n--- 🚀 本地分析报告 ---');
    console.log(JSON.stringify(finalReport, null, 2));
}

main().catch(console.error);