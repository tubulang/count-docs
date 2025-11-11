#!/usr/bin/env node

// -----------------------------------------------------------------------------
// 本地 NPM 包 API 分析器 (V12 - 架构修复，正确区分 JS/TS)
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
// 辅助工具 (无变化)
// -----------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function hasValidJSDoc(comments) {
    if (!comments || comments.length === 0) { return false; }
    // V12 变更: 简化 JSDoc 检查, TS API 返回的是 {text, kind} 数组
    const docText = comments.map(c => c.text).join('\n');
    if (docText.trim().length === 0) return false;
    
    // 基础检查：必须包含描述或标签
    try {
        const doc = doctrine.parse(`/**\n${docText}\n*/`, { unwrap: true });
        return doc.description.length > 0 || doc.tags.length > 0;
    } catch (e) { return false; }
}
// V12 变更: Babel 的 JSDoc 检查
function hasValidJSDocBabel(node) {
    const comments = node?.leadingComments;
    if (!comments || comments.length === 0) { return false; }
    const lastComment = comments[comments.length - 1];
    if (lastComment.type !== 'CommentBlock' || !lastComment.value.startsWith('*')) { return false; }
    try {
        const doc = doctrine.parse(`/*${lastComment.value}*/`, { unwrap: true });
        return doc.description.length > 0 || doc.tags.length > 0;
    } catch (e) { return false; }
}

function symbolBelongsToPackage(symbol, packageRoot) {
    if (!symbol || !packageRoot) return true;
    const declarations = symbol.declarations || [];
    if (declarations.length === 0) return true;
    const normalizedRoot = path.resolve(packageRoot);
    return declarations.some(decl => {
        const filePath = path.resolve(decl.getSourceFile().fileName);
        if (!filePath.startsWith(normalizedRoot)) return false;
        const nodeModulesSegment = `${path.sep}node_modules${path.sep}`;
        return !filePath.includes(nodeModulesSegment);
    });
}

function isTypeOnlyExportSymbol(symbol) {
    if (!symbol || !symbol.declarations || symbol.declarations.length === 0) return false;
    let sawSpecifier = false;
    for (const decl of symbol.declarations) {
        if (ts.isExportSpecifier(decl)) {
            sawSpecifier = true;
            const parentExport = decl.parent?.parent;
            const typeOnly = decl.isTypeOnly || (parentExport && ts.isExportDeclaration(parentExport) && parentExport.isTypeOnly);
            if (!typeOnly) return false;
            continue;
        }
        if (ts.isExportDeclaration(decl)) {
            sawSpecifier = true;
            if (!decl.isTypeOnly) return false;
            continue;
        }
        return false;
    }
    return sawSpecifier;
}

async function safeReadFile(filePath) {
    try { return await fs.readFile(filePath, 'utf-8'); } catch (e) { return null; }
}

async function resolveModulePath(baseDir, relativePath, extensions) {
    const absolutePath = path.resolve(baseDir, relativePath);
    for (const ext of extensions) {
        const fullPath = `${absolutePath}${ext}`;
        if (await fs.pathExists(fullPath) && (await fs.stat(fullPath)).isFile()) {
            return fullPath;
        }
    }
    for (const ext of extensions) {
        const fullPath = path.join(absolutePath, `index${ext}`);
        if (await fs.pathExists(fullPath) && (await fs.stat(fullPath)).isFile()) {
            return fullPath;
        }
    }
    if (await fs.pathExists(absolutePath) && (await fs.stat(absolutePath)).isFile()) {
        return absolutePath;
    }
    return null;
}

// -----------------------------------------------------------------------------
// 核心分析器 (V12 架构重构)
// -----------------------------------------------------------------------------

/**
 * 1. 分析 JS 文件 (仅限 .js, .mjs, .cjs)
 */
async function parseJsFile(filePath, results) {
    const newFilesToAnalyze = new Set();
    const code = await safeReadFile(filePath);
    if (!code) {
        results.errors.push(`Could not read JS entry file: ${filePath}`);
        return newFilesToAnalyze;
    }

    let ast;
    try {
        ast = babelParse(code, {
            sourceType: 'module',
            plugins: ['jsx', 'exportDefaultFrom'], // V12: 移除 'typescript' 插件
        });
    } catch (e) {
        results.errors.push(`Babel parse error in ${filePath}: ${e.message}`);
        return newFilesToAnalyze;
    }

    const traverse = babelTraverse.default;
    const relativePathsToResolve = []; 
    
    // 阶段 1: 同步收集
    traverse(ast, {
        ExportNamedDeclaration: (path) => { 
            if (path.node.source) {
                const relativePath = path.node.source.value;
                if (relativePath.startsWith('.')) {
                    relativePathsToResolve.push(relativePath); 
                } else {
                    results.reExports.add(relativePath);
                }
            } else if (path.node.declaration) {
                const declarations = path.node.declaration.declarations || [path.node.declaration];
                declarations.forEach(decl => {
                    const apiName = decl.id?.name || (decl.id?.type === 'ObjectPattern' ? '[ObjectPattern]' : 'unknown');
                    results.js.list.push(apiName);
                    if (!hasValidJSDocBabel(path.node)) { results.js.undocumentedList.push(apiName); }
                    else { results.js.documentedList.push(apiName); }
                });
            } else if (path.node.specifiers) {
                path.node.specifiers.forEach(spec => {
                    const apiName = spec.exported.name || spec.exported.value;
                    results.js.list.push(apiName);
                    if (!hasValidJSDocBabel(path.node)) { results.js.undocumentedList.push(apiName); }
                    else { results.js.documentedList.push(apiName); }
                });
            }
        },
        ExportAllDeclaration: (path) => { 
            if (path.node.source) {
                const relativePath = path.node.source.value;
                if (relativePath.startsWith('.')) {
                    relativePathsToResolve.push(relativePath); 
                } else {
                    results.reExports.add(relativePath);
                }
            }
        },
        ExportDefaultDeclaration(path) {
            const apiName = 'default';
            results.js.list.push(apiName);
            if (!hasValidJSDocBabel(path.node)) { results.js.undocumentedList.push(apiName); }
            else { results.js.documentedList.push(apiName); }
        },
    });

    // 阶段 2: 异步解析
    const baseDir = path.dirname(filePath);
    // V12: JS 文件只能递归到 JS 或 TS 文件
    const extensions = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.d.ts']; 
    for (const relativePath of relativePathsToResolve) {
        const newFile = await resolveModulePath(baseDir, relativePath, extensions); 
        if (newFile) newFilesToAnalyze.add(newFile);
    }

    return newFilesToAnalyze;
}

/**
 * 2. 分析 TS 文件 (.ts, .tsx, .d.ts)
 */
async function parseTsFile(filePath, results) {
    const newFilesToAnalyze = new Set();
    const relativePathsToResolve = [];
    const packageRoot = results.packagePath ? path.resolve(results.packagePath) : null;
    
    if (!filePath || !(await fs.pathExists(filePath))) {
        results.errors.push(`Could not find TS entry file: ${filePath}`);
        return newFilesToAnalyze;
    }
    
    let program;
    try {
        program = ts.createProgram([filePath], { allowJs: true, checkJs: false });
    } catch (e) {
        results.errors.push(`TS Program creation failed: ${e.message}`);
        return newFilesToAnalyze;
    }
    
    const sourceFile = program.getSourceFile(filePath);
    if (!sourceFile) {
        results.errors.push(`TS SourceFile not found: ${filePath}`);
        return newFilesToAnalyze;
    }

    // 阶段 1: 同步收集 (用于递归)
    ts.forEachChild(sourceFile, (node) => {
        if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
            const relativePath = node.moduleSpecifier.text;
            if (relativePath.startsWith('.')) {
                const exportClause = node.exportClause ?? null;
                const isExportAll = !exportClause;
                if (isExportAll) {
                    relativePathsToResolve.push(relativePath);
                }
            }
        }
    });

    const checker = program.getTypeChecker();
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (moduleSymbol) {
        const exports = checker.getExportsOfModule(moduleSymbol);
        
        // --- 变更 (V12): 关键的区分逻辑 ---
        exports.forEach(symbol => {
            if (symbol.name.startsWith('__')) return;
            const apiName = symbol.name;

            const targetSymbol = (symbol.flags & ts.SymbolFlags.Alias)
                ? checker.getAliasedSymbol(symbol) || symbol
                : symbol;

            const isInternalSymbol = symbolBelongsToPackage(targetSymbol, packageRoot);
            if (!isInternalSymbol) {
                results.reExportedApis.add(apiName);
            }

            const typeOnlyExport = isTypeOnlyExportSymbol(symbol);

            const comments = targetSymbol.getDocumentationComment(checker);
            const hasDocs = hasValidJSDoc(comments);
            
            // 检查它是什么类型的导出
            const isValue = !typeOnlyExport && (targetSymbol.flags & ts.SymbolFlags.Value); // Class, Function, Var
            const isType = typeOnlyExport || (targetSymbol.flags & ts.SymbolFlags.Type);  // Interface, Type Alias
            
            if (isValue) {
                results.js.list.push(apiName);
                if (!hasDocs) results.js.undocumentedList.push(apiName);
                else results.js.documentedList.push(apiName);
            }
            
            if (isType) {
                results.ts.list.push(apiName);
                if (!hasDocs) results.ts.undocumentedList.push(apiName);
                else results.ts.documentedList.push(apiName);
            }
            // --- 变更结束 ---
        });
    } else {
        results.errors.push(`Could not find module symbol for: ${filePath}`);
    }

    // 阶段 2: 异步解析
    const baseDir = path.dirname(filePath);
    // V12: TS 文件可以递归到 JS 或 TS
    const extensions = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.d.ts'];
    for (const relativePath of relativePathsToResolve) {
        const newFile = await resolveModulePath(baseDir, relativePath, extensions);
        if (newFile) newFilesToAnalyze.add(newFile);
    }
    
    return newFilesToAnalyze;
}


// processExposesObjectLiteral (无变化)
async function processExposesObjectLiteral(exposesObj, packageRoot, results, fileQueue) {
    for (const [key, value] of Object.entries(exposesObj)) {
        const apiName = key;
        const filePath = value;
        results.mf.list.push(apiName);
        results.mf.undocumentedList.push(apiName);
        if (typeof filePath === 'string') {
            const absolutePath = path.resolve(packageRoot, filePath);
            if (await fs.pathExists(absolutePath)) {
                fileQueue.add(absolutePath); // V12: 添加到统一队列
            } else {
                results.errors.push(`MF exposes (from JSON) missing file: ${filePath} (resolved to ${absolutePath})`);
            }
        }
    }
}

// parseMfExports (无变化, 除了 V12 队列)
async function parseMfExports(packageRoot, results, fileQueue, explicitConfigPath) {
    let configFiles = [];
    if (explicitConfigPath) {
        if (await fs.pathExists(explicitConfigPath)) {
            configFiles = [explicitConfigPath];
            console.log(`[MF 分析] 使用显式路径: ${explicitConfigPath}`);
        } else {
            results.errors.push(`提供的 MF 配置文件路径未找到: ${explicitConfigPath}`);
            return;
        }
    } else {
        console.log('[MF 分析] 正在自动搜索 webpack/mf 配置文件...');
        configFiles = await glob('**/{webpack,webpack.config,mf.config}.*.{js,mjs,cjs}', {
            cwd: packageRoot,
            ignore: 'node_modules/**',
            absolute: true,
        });
    }
    if (configFiles.length === 0) {
        if (!explicitConfigPath) { console.log('[MF 分析] 未自动找到配置文件。'); }
        return;
    }
    const processExposesObject = async (exposesObject, packageRoot, results, fileQueue) => {
        if (!exposesObject || exposesObject.type !== 'ObjectExpression') return;
        for (const prop of exposesObject.properties) {
            if (prop.type !== 'ObjectProperty') continue; 
            const apiName = prop.key.name || prop.key.value;
            if (!apiName) continue;
            results.mf.list.push(apiName);
            results.mf.undocumentedList.push(apiName);
            if (prop.value.type === 'StringLiteral') {
                const filePath = prop.value.value;
                const absolutePath = path.resolve(packageRoot, filePath);
                if (await fs.pathExists(absolutePath)) {
                    fileQueue.add(absolutePath); // V12: 添加到统一队列
                } else {
                    results.errors.push(`MF exposes missing file: ${filePath} (resolved to ${absolutePath})`);
                }
            }
        }
    };
    const isExposesObject = (objectNode) => {
        if (!objectNode || objectNode.type !== 'ObjectExpression') return false;
        if (objectNode.properties.length === 0) return false;
        let exposeLikeKeys = 0;
        let totalKeys = 0;
        for (const prop of objectNode.properties) {
            if (prop.type === 'ObjectProperty') {
                totalKeys++;
                const keyName = prop.key.name || prop.key.value;
                if (keyName && keyName.startsWith('./')) {
                    exposeLikeKeys++;
                }
            }
        }
        return totalKeys > 0 && (exposeLikeKeys / totalKeys > 0.5);
    };
    for (const configPath of configFiles) {
        const code = await safeReadFile(configPath);
        if (!code) {
            results.errors.push(`Could not read Webpack config: ${configPath}`);
            continue;
        }
        let ast;
        try { ast = babelParse(code, { sourceType: 'module' }); }
        catch (e) {
            try { ast = babelParse(code, { sourceType: 'script' }); }
            catch (e2) {
                results.errors.push(`Babel parse error in ${configPath}: ${e2.message}`);
                continue;
            }
        }
        const traverse = babelTraverse.default;
        let foundExposes = false;
        traverse(ast, {
            ObjectProperty(path) {
                const keyName = path.node.key.name || path.node.key.value;
                if (keyName === 'exposes' && path.node.value.type === 'ObjectExpression') {
                    console.log(`[MF 分析] 在 ${configPath} 中找到 'exposes' 键。`);
                    processExposesObject(path.node.value, packageRoot, results, fileQueue);
                    foundExposes = true;
                    path.stop();
                }
            }
        });
        if (!foundExposes) {
            console.log(`[MF 分析] 未在 ${configPath} 中找到 'exposes' 键，将进行启发式搜索...`);
            traverse(ast, {
                ObjectExpression(path) {
                    if (isExposesObject(path.node)) {
                        console.log(`[MF 分析] 启发式搜索在 ${configPath} 中找到一个疑似 'exposes' 的对象。`);
                        processExposesObject(path.node, packageRoot, results, fileQueue);
                        foundExposes = true;
                        path.stop(); 
                    }
                }
            });
        }
    }
}


// findEntryPoints (无变化)
async function findEntryPoints(packageJson, packageRoot) {
    const entryPoints = { js: new Set(), ts: new Set() };
    if (packageJson.types) { entryPoints.ts.add(path.resolve(packageRoot, packageJson.types)); }
    if (packageJson.main) { entryPoints.js.add(path.resolve(packageRoot, packageJson.main)); }
    if (packageJson.module) { entryPoints.js.add(path.resolve(packageRoot, packageJson.module)); }
    if (packageJson.exports) {
        const exports = packageJson.exports;
        const entries = typeof exports === 'string' ? { '.': exports } : exports;
        for (const [key, value] of Object.entries(entries)) {
            let entry = value;
            if (typeof value === 'object' && value !== null) {
                entry = value.import || value.require || value.default || null;
                if (value.types) { entryPoints.ts.add(path.resolve(packageRoot, value.types)); }
            }
            if (typeof entry === 'string') {
                const ext = path.extname(entry);
                if (ext === '.d.ts') { entryPoints.ts.add(path.resolve(packageRoot, entry)); }
                else if (['.js', '.mjs', '.cjs'].includes(ext)) { entryPoints.js.add(path.resolve(packageRoot, entry)); }
            }
        }
    }
    if (entryPoints.ts.size === 0 && entryPoints.js.size > 0) {
        const firstJs = [...entryPoints.js][0];
        const potentialTs = firstJs.replace(/\.js$/, '.d.ts');
        if (await fs.pathExists(potentialTs)) { entryPoints.ts.add(potentialTs); }
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
// 主执行函数 (V12 架构重构)
// -----------------------------------------------------------------------------

async function main() {
    // --- 解析参数 (无变化) ---
    const packagePathInput = process.argv[2];
    let mfConfigPathInput = null;
    let mfExposesInput = null; 
    const mfFlagIndex = process.argv.indexOf('--mf-config');
    const mfExposesFlagIndex = process.argv.indexOf('--mf-exposes'); 
    if (mfExposesFlagIndex !== -1 && process.argv[mfExposesFlagIndex + 1]) {
        mfExposesInput = process.argv[mfExposesFlagIndex + 1];
    } else if (mfFlagIndex !== -1 && process.argv[mfFlagIndex + 1]) {
        mfConfigPathInput = process.argv[mfFlagIndex + 1];
    }
    if (!packagePathInput) {
        console.error('错误: 请提供一个本地包的路径。');
        console.log('用法: node analyze.js <path> [--mf-exposes \'{...}\'] [--mf-config /path/to/file.js]');
        process.exit(1);
    }
    const packageRoot = path.resolve(process.cwd(), packagePathInput);
    const packageJsonPath = path.join(packageRoot, 'package.json');
    let absoluteMfConfigPath = null;
    if (mfConfigPathInput) {
        absoluteMfConfigPath = path.resolve(process.cwd(), mfConfigPathInput);
    }
    // --- 结束 ---

    console.log(`[1/4] 正在分析本地包: ${packageRoot}`);
    if (!(await fs.pathExists(packageJsonPath))) {
        console.error(`错误: 在 ${packageJsonPath} 未找到 package.json。`);
        process.exit(1);
    }
    const packageJson = await fs.readJson(packageJsonPath);
    const packageName = packageJson.name || path.basename(packageRoot);
    
    const results = {
        packageName: packageName, packagePath: packageRoot,
        js: { total: 0, undocumented: 0, documented: 0, list: [], undocumentedList: [], documentedList: [] },
        ts: { total: 0, undocumented: 0, documented: 0, list: [], undocumentedList: [], documentedList: [] },
        mf: { total: 0, undocumented: 0, documented: 0, list: [], undocumentedList: [], documentedList: [] },
        reExports: new Set(), reExportedApis: new Set(),
        entryPoints: { js: [], ts: [] }, errors: [],
    };

    try {
        console.log('[2/4] 正在分析入口点 (package.json 和 MF)...');
        const entryPoints = await findEntryPoints(packageJson, packageRoot);
        
        // --- 变更 (V12): 统一的工作队列 ---
        const fileQueue = new Set([...entryPoints.js, ...entryPoints.ts]);

        if (mfExposesInput) {
            console.log('[MF 分析] 使用显式 --mf-exposes JSON...');
            try {
                const jsonSafeInput = mfExposesInput.replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3'); 
                const exposesObj = JSON.parse(jsonSafeInput);
                await processExposesObjectLiteral(exposesObj, packageRoot, results, fileQueue);
            } catch (e) {
                results.errors.push(`--mf-exposes 处理失败 (可能是 JSON 解析或内部错误): ${e.message}`);
                console.error(`解析失败的输入: ${mfExposesInput}`);
            }
        } else {
            await parseMfExports(packageRoot, results, fileQueue, absoluteMfConfigPath);
        }
        
        // V12: entryPoints 只是为了报告，不再用于 js/ts 队列
        results.entryPoints.js = [...entryPoints.js];
        results.entryPoints.ts = [...entryPoints.ts];
        
        console.log('[3/4] 正在递归分析所有找到的 API ...');

        // --- 变更 (V12): 统一的递归分析循环 ---
        const processedFiles = new Set();
        while (fileQueue.size > 0) {
            const currentFile = fileQueue.values().next().value;
            fileQueue.delete(currentFile);
            if (processedFiles.has(currentFile)) continue;
            processedFiles.add(currentFile);
            
            const ext = path.extname(currentFile);
            let newFiles = new Set();
            
            if (['.js', '.mjs', '.cjs'].includes(ext)) {
                newFiles = await parseJsFile(currentFile, results);
            } else if (['.ts', '.tsx', '.d.ts'].includes(ext)) {
                newFiles = await parseTsFile(currentFile, results);
            } else {
                results.errors.push(`未知的入口文件类型: ${currentFile}`);
            }
            
            newFiles.forEach(file => fileQueue.add(file));
        }
        // --- 变更结束 ---

    } catch (e) {
        console.error(`分析过程中发生致命错误: ${e.message}`);
        results.errors.push(e.stack);
    }

    // --- 报告处理 (无变化) ---
    const processResults = (key) => {
        const uniqueList = [...new Set(results[key].list)];
        const uniqueDocs = [...new Set(results[key].documentedList)];
        const docSet = new Set(uniqueDocs);
        const uniqueUndocumented = [...new Set(results[key].undocumentedList)]
            .filter(name => !docSet.has(name));
        results[key].list = uniqueList;
        results[key].documentedList = uniqueDocs;
        results[key].undocumentedList = uniqueUndocumented;
        results[key].total = uniqueList.length;
        results[key].documented = uniqueDocs.length;
        results[key].undocumented = uniqueUndocumented.length;
    };
    processResults('js'); processResults('ts'); processResults('mf');
    const finalReport = {
        ...results,
        reExports: [...results.reExports],
        reExportedApis: [...results.reExportedApis],
    };
    
    // --- 保存报告 (无变化) ---
    console.log('[4/4] 正在保存分析报告...');
    const safeProjectName = results.packageName.replace(/@/g, '').replace(/\//g, '_');
    const now = new Date();
    const pad = (n) => n.toString().padStart(2, '0');
    const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const timeStr = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    const fileTimestamp = `${dateStr}_${timeStr}`;
    const reportsRoot = path.resolve(__dirname, 'analysis_reports');
    const projectReportDir = path.join(reportsRoot, safeProjectName);
    const reportFullPath = path.join(projectReportDir, `${fileTimestamp}.json`);
    try {
        await fs.ensureDir(projectReportDir);
        await fs.writeJson(reportFullPath, finalReport, { spaces: 2 });
        console.log(`✅ 报告已成功保存到: ${reportFullPath}`);
    } catch (saveError) {
        console.error(`❌ 保存报告失败: ${saveError.message}`);
    }

    // --- 打印报告 (无变化) ---
    console.log('\n--- 🚀 本地分析报告 ---');
    console.log(JSON.stringify(finalReport, null, 2));
}

main().catch(console.error);
