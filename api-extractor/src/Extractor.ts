import * as ts from 'typescript';
import * as fsx from 'fs-extra';
import * as path from 'path';
import ApiPackage from './definitions/ApiPackage';
import DocItemLoader from './DocItemLoader';

export type ApiErrorHandler = (message: string, fileName: string, lineNumber: number) => void;

/**
 * Options for Extractor contructor.
 */
export interface IExtractorOptions {
  /**
    * Configuration for the TypeScript compiler.  The most important options to set are:
    *
    * - target: ts.ScriptTarget.ES5
    * - module: ts.ModuleKind.CommonJS
    * - moduleResolution: ts.ModuleResolutionKind.NodeJs
    * - rootDir: inputFolder
    */
  compilerOptions: ts.CompilerOptions;

  errorHandler?: ApiErrorHandler;
}

/**
  * Options for Extractor.analyze()
  */
export interface IExtractorAnalyzeOptions {
  /**
    * The entry point for the project.  This should correspond to the "main" field
    * from NPM's package.json file.  If it is a relative path, it will be relative to
    * the project folder described by IExtractorAnalyzeOptions.compilerOptions.
    */
  entryPointFile: string;

  /**
    * This can be used to specify other files that should be processed by the TypeScript compiler
    * for some reason, e.g. a "typings/tsd.d.ts" file.  It is NOT necessary to specify files that
    * are explicitly imported/required by the entryPointFile, since the compiler will trace
    * (the transitive closure of) ordinary dependencies.
    */
  otherFiles?: string[];
}

/**
  * The main entry point for the "api-extractor" utility.  The Analyzer object invokes the
  * TypeScript Compiler API to analyze a project, and constructs the ApiItem
  * abstract syntax tree.
  */
export default class Extractor {
  public errorHandler: ApiErrorHandler;
  public typeChecker: ts.TypeChecker;
  public package: ApiPackage;
  /**
   * One DocItemLoader is needed per analyzer to look up external API members
   * as needed.
   */
  public docItemLoader: DocItemLoader;

  private _compilerOptions: ts.CompilerOptions;

  /**
    * The default implementation of ApiErrorHandler, which merely writes to console.log().
    */
  public static defaultErrorHandler(message: string, fileName: string, lineNumber: number): void {
    console.log(`ERROR: [${fileName}:${lineNumber}] ${message}`);
  }

  constructor(options: IExtractorOptions) {
    this._compilerOptions = options.compilerOptions;
    this.docItemLoader = new DocItemLoader(options.compilerOptions.rootDir);
    this.errorHandler = options.errorHandler || Extractor.defaultErrorHandler;
  }

  /**
    * Analyzes the specified project.
    */
  public analyze(options: IExtractorAnalyzeOptions): void {
    const rootFiles: string[] = [options.entryPointFile].concat(options.otherFiles || []);

    const program: ts.Program = ts.createProgram(rootFiles, this._compilerOptions);

    // This runs a full type analysis, and then augments the Abstract Syntax Tree (i.e. declarations)
    // with semantic information (i.e. symbols).  The "diagnostics" are a subset of the everyday
    // compile errors that would result from a full compilation.
    for (const diagnostic of program.getSemanticDiagnostics()) {
      this.reportError('TypeScript: ' + diagnostic.messageText, diagnostic.file, diagnostic.start);
    }

    this.typeChecker = program.getTypeChecker();

    const rootFile: ts.SourceFile = program.getSourceFile(options.entryPointFile);
    if (!rootFile) {
      throw new Error('Unable to load file: ' + options.entryPointFile);
    }

    this.package = new ApiPackage(this, rootFile); // construct members
    this.package.completeInitialization(); // creates ApiDocumentation
  }

  /**
    * Reports an error message to the registered ApiErrorHandler.
    */
  public reportError(message: string, sourceFile: ts.SourceFile, start: number): void {
    const lineNumber: number = sourceFile.getLineAndCharacterOfPosition(start).line;
    this.errorHandler(message, sourceFile.fileName, lineNumber);
  }

  /**
   * Scans for external package api files and loads them into the docItemLoader member before
   * any API analyzation begins.
   *
   * @param externalJsonCollectionPath - an absolute path to to the folder that contains all the external
   * api json files.
   * Ex: if externalJsonPath is './resources', then in that folder
   * are 'es6-collections.api.json', 'es6-promise.api.json', etc.
   */
  public loadExternalPackages(externalJsonCollectionPath: string): void {
    if (!externalJsonCollectionPath) {
      return;
    }

    const files: string[] = fsx.readdirSync(externalJsonCollectionPath);
    files.forEach(file => {
      if (path.extname(file) === '.json') {
        const externalJsonFilePath: string = path.join(externalJsonCollectionPath, file);
        this.docItemLoader.loadPackageIntoCache(externalJsonFilePath);
      }
    });
  }
}
