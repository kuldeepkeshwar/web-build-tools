/* tslint:disable:no-bitwise */

import * as ts from 'typescript';
import Extractor from '../Extractor';
import ApiStructuredType from './ApiStructuredType';
import ApiEnum from './ApiEnum';
import ApiFunction from './ApiFunction';
import ApiItem, { ApiItemKind, IApiItemOptions } from './ApiItem';
import ApiItemContainer from './ApiItemContainer';
import TypeScriptHelpers from '../TypeScriptHelpers';

/**
  * This class is part of the ApiItem abstract syntax tree.  It represents the top-level
  * exports for an Rush package.  This object acts as the root of the Extractor's tree.
  */
export default class ApiPackage extends ApiItemContainer {
  private static _getOptions(extractor: Extractor, rootFile: ts.SourceFile): IApiItemOptions {
    const rootFileSymbol: ts.Symbol = TypeScriptHelpers.getSymbolForDeclaration(rootFile);
    let statement: ts.VariableStatement;
    let foundDescription: ts.Node = undefined;

    for (const statementNode of rootFile.statements) {
      if (statementNode.kind === ts.SyntaxKind.VariableStatement) {
        statement = statementNode as ts.VariableStatement;
        for (const statementDeclaration of statement.declarationList.declarations) {
          if (statementDeclaration.name.getText() === 'packageDescription') {
            foundDescription = statement;
          }
        }
      }
    }

    return {
      extractor,
      declaration: rootFileSymbol.declarations[0],
      declarationSymbol: rootFileSymbol,
      jsdocNode: foundDescription
    };
  }
  constructor(extractor: Extractor, rootFile: ts.SourceFile) {
    super(ApiPackage._getOptions(extractor, rootFile));
    this.kind = ApiItemKind.Package;

    const exportSymbols: ts.Symbol[] = this.typeChecker.getExportsOfModule(this.declarationSymbol);
    if (exportSymbols) {
      for (const exportSymbol of exportSymbols) {
        const followedSymbol: ts.Symbol = this.followAliases(exportSymbol);

        if (!followedSymbol.declarations) {
          this.reportWarning(`Definition with no declarations: ${exportSymbol.name}`);
          continue;
        }

        for (const declaration of followedSymbol.declarations) {
          const options: IApiItemOptions = {
            extractor: this.extractor,
            declaration,
            declarationSymbol: followedSymbol,
            jsdocNode: declaration,
            exportSymbol
          };

          if (followedSymbol.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface)) {
            this.addMemberItem(new ApiStructuredType(options));
          } else if (followedSymbol.flags & ts.SymbolFlags.Function) {
            this.addMemberItem(new ApiFunction(options));
          } else if (followedSymbol.flags & ts.SymbolFlags.Enum) {
            this.addMemberItem(new ApiEnum(options));
          } else {
            this.reportWarning(`Unsupported export: ${exportSymbol.name}`);
          }
        }
      }
    }
  }

  /**
   * Find a member in this package by name and return it if found.
   *
   * @param memberName - the name of the member ApiItem
   */
  public getMemberItem(memberName: string): ApiItem {
    if (this.memberItems.has(memberName)) {
      return this.memberItems.get(memberName);
    }
    return undefined;
  }

  public shouldHaveDocumentation(): boolean {
    // We don't write JSDoc for the ApiPackage object
    return false;
  }
}
