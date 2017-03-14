// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as colors from 'colors';
import * as glob from 'glob';
import globEscape = require('glob-escape');
import * as os from 'os';
import * as path from 'path';
import * as semver from 'semver';
import * as fsx from 'fs-extra';
import { CommandLineAction, CommandLineFlagParameter } from '@microsoft/ts-command-line';
import {
  AsyncRecycle,
  IPackageJson,
  JsonFile,
  RushConfiguration,
  RushConfigurationProject,
  Utilities,
  Stopwatch
} from '@microsoft/rush-lib';

import InstallAction from './InstallAction';
import RushCommandLineParser from './RushCommandLineParser';
import PackageReviewChecker from '../utilities/PackageReviewChecker';
import { TempModuleGenerator } from '../utilities/TempModuleGenerator';

interface IShrinkwrapFile {
  name: string;
  version: string;
  dependencies: { [dependency: string]: IShrinkwrapDependency };
}

interface IShrinkwrapDependency {
  version: string;
  from: string;
  resolved: string;
  dependencies: { [dependency: string]: IShrinkwrapDependency };
}

export default class GenerateAction extends CommandLineAction {
  private _parser: RushCommandLineParser;
  private _rushConfiguration: RushConfiguration;
  private _packageReviewChecker: PackageReviewChecker;
  private _lazyParameter: CommandLineFlagParameter;
  private _forceParameter: CommandLineFlagParameter;

  private static _deleteCommonNodeModules(rushConfiguration: RushConfiguration, isLazy: boolean): void {
    const nodeModulesPath: string = path.join(rushConfiguration.commonFolder, 'node_modules');

    if (isLazy) {
      // In the lazy case, we keep the existing common/node_modules.  However, we need to delete
      // the temp projects (that were copied from common/temp_modules into common/node_modules).
      // We can recognize them because their names start with "rush-"
      console.log('Deleting common/node_modules/rush-*');
      const normalizedPath: string = Utilities.getAllReplaced(nodeModulesPath, '\\', '/');
      for (const tempModulePath of glob.sync(globEscape(normalizedPath) + '/rush-*')) {
        AsyncRecycle.recycleDirectory(rushConfiguration, tempModulePath);
      }
    } else {
      if (fsx.existsSync(nodeModulesPath)) {
        console.log('Deleting common/node_modules folder...');
        AsyncRecycle.recycleDirectory(rushConfiguration, nodeModulesPath);
      }
    }
  }

  private static _deleteCommonTempModules(rushConfiguration: RushConfiguration): void {
    if (fsx.existsSync(rushConfiguration.tempModulesFolder)) {
      console.log('Deleting common/temp_modules folder');
      Utilities.dangerouslyDeletePath(rushConfiguration.tempModulesFolder);
    }
  }

  private static _deleteShrinkwrapFile(rushConfiguration: RushConfiguration): void {
    const shrinkwrapFilename: string = path.join(rushConfiguration.commonFolder, 'npm-shrinkwrap.json');

    if (fsx.existsSync(shrinkwrapFilename)) {
      console.log('Deleting common/npm-shrinkwrap.json');
      Utilities.dangerouslyDeletePath(shrinkwrapFilename);
    }
  }

  private static _createCommonTempModulesAndPackageJson(rushConfiguration: RushConfiguration):
    Map<string, IPackageJson> {
    console.log('Creating a clean common/temp_modules folder');
    Utilities.createFolderWithRetry(rushConfiguration.tempModulesFolder);

    const commonPackageJson: PackageJson = {
      dependencies: {},
      description: 'Temporary file generated by the Rush tool',
      name: 'rush-common',
      private: true,
      version: '0.0.0'
    };

    // Add any pinned versions to the top of the commonPackageJson
    rushConfiguration.pinnedVersions.forEach((version: string, dependency: string) => {
      commonPackageJson.dependencies[dependency] = version;
    });

    console.log('Creating temp projects...');

    // To make the common/package.json file more readable, sort alphabetically
    // according to rushProject.tempProjectName instead of packageName.
    const sortedRushProjects: RushConfigurationProject[] = rushConfiguration.projects.slice(0);
    sortedRushProjects.sort(
      (a: RushConfigurationProject, b: RushConfigurationProject) => a.tempProjectName.localeCompare(b.tempProjectName)
    );

    const tempModules: Map<string, IPackageJson> = new TempModuleGenerator(rushConfiguration).tempModules;

    for (const rushProject of sortedRushProjects) {
      const packageJson: PackageJson = rushProject.packageJson;

      const tempProjectName: string = rushProject.tempProjectName;

      const tempProjectFolder: string = path.join(rushConfiguration.tempModulesFolder, tempProjectName);
      fsx.mkdirSync(tempProjectFolder);

      commonPackageJson.dependencies[tempProjectName] = 'file:./temp_modules/' + tempProjectName;

      const tempPackageJsonFilename: string = path.join(tempProjectFolder, 'package.json');

      JsonFile.saveJsonFile(tempModules.get(rushProject.packageName), tempPackageJsonFilename);
    }

    console.log('Writing common/package.json');
    const commonPackageJsonFilename: string = path.join(rushConfiguration.commonFolder, 'package.json');
    JsonFile.saveJsonFile(commonPackageJson, commonPackageJsonFilename);
    return tempModules;
  }

  private static _runNpmInstall(rushConfiguration: RushConfiguration): void {
    const npmInstallArgs: string[] = ['install'];
    if (rushConfiguration.cacheFolder) {
      npmInstallArgs.push('--cache', rushConfiguration.cacheFolder);
    }

    if (rushConfiguration.tmpFolder) {
      npmInstallArgs.push('--tmp', rushConfiguration.tmpFolder);
    }

    console.log(os.EOL + colors.bold(`Running "npm ${npmInstallArgs.join(' ')}"...`));
    Utilities.executeCommand(rushConfiguration.npmToolFilename,
                             npmInstallArgs,
                             rushConfiguration.commonFolder);
    console.log('"npm install" completed' + os.EOL);
  }

  private static _runNpmShrinkWrap(rushConfiguration: RushConfiguration, isLazy: boolean): void {
    if (isLazy) {
      // If we're not doing it for real, then don't bother with "npm shrinkwrap"
      console.log(os.EOL + colors.bold('(Skipping "npm shrinkwrap")') + os.EOL);
    } else {
      console.log(os.EOL + colors.bold('Running "npm shrinkwrap"...'));
      Utilities.executeCommand(rushConfiguration.npmToolFilename,
                               ['shrinkwrap' ],
                               rushConfiguration.commonFolder);
      console.log('"npm shrinkwrap" completed' + os.EOL);
    }
  }

  private static _shouldDeleteNodeModules(
    rushConfiguration: RushConfiguration,
    tempModules: Map<string, IPackageJson>): boolean {
    /* check against the temp_modules: are any regular dependencies in temp_modules missing from the shrinkwrap?
     * note that we will not regenerate the shrinkwrap if they are REMOVING dependencies,
     * we assume they will use --force to remove those from shrinkwrap
     */

    const shrinkwrapFile: string = path.join(rushConfiguration.commonFolder, 'npm-shrinkwrap.json');
    if (!fsx.existsSync(shrinkwrapFile)) {
      console.log(colors.yellow(`Could not find previous shrinkwrap file.${os.EOL}` +
            `Rush must regenerate the shrinkwrap file. This may take some time...`));
      return true;
    }

    const shrinkwrap: IShrinkwrapFile = JSON.parse( fsx.readFileSync(shrinkwrapFile).toString() );

    let hasFoundMissingDependency: boolean = false;

    tempModules.forEach((project: IPackageJson, projectName: string) => {
      const tempProjectName: string = rushConfiguration.projectsByName.get(projectName).tempProjectName;
      Object.keys(project.dependencies).forEach((dependency: string) => {
        // technically we need to look at the temp_modules dependencies
        const version: string = project.dependencies[dependency];
        if (!GenerateAction._canFindDependencyInShrinkwrap(shrinkwrap, dependency, version, tempProjectName)) {
          console.log(colors.yellow(
            `${os.EOL}Could not find "${projectName}" dependency "${dependency}@${version}" in shrinkwrap.`));
          hasFoundMissingDependency = true;
        }
      });
    });
    if (!hasFoundMissingDependency) {
      console.log(colors.green(
        `${os.EOL}Rush found all dependencies in the shrinkwrap! Rush now running in "fast" mode.`));
    } else {
      console.log(colors.yellow(`${os.EOL}The shrinkwrap file was missing one or more dependencies. ` +
        `Rush must delete and replace the node_modules folder. This may take some time...`));
    }
    return hasFoundMissingDependency;
  }

  private static _canFindDependencyInShrinkwrap(
    shrinkwrap: IShrinkwrapFile,
    dependency: string,
    version: string,
    rushPackageName: string): boolean {

    let shrinkwrapDependency: IShrinkwrapDependency;

    // The dependency will either be directly under the rushPackageName, or it will be in the root
    if (shrinkwrap.dependencies[rushPackageName]) {
      if (shrinkwrap.dependencies[rushPackageName].dependencies) {
        shrinkwrapDependency = shrinkwrap.dependencies[rushPackageName].dependencies[dependency];
      }
    }

    shrinkwrapDependency = shrinkwrapDependency || shrinkwrap.dependencies[dependency];

    return shrinkwrapDependency && semver.satisfies(shrinkwrapDependency.version, version);
  }

  constructor(parser: RushCommandLineParser) {
    super({
      actionVerb: 'generate',
      summary: 'Run this command after changing any project\'s package.json.',
      documentation: 'Run "rush regenerate" after changing any project\'s package.json.'
      + ' It scans the dependencies for all projects referenced in "rush.json", and then'
      + ' constructs a superset package.json in the Rush common folder.'
      + ' After running this command, you will need to commit your changes to git.'
    });
    this._parser = parser;
  }

  protected onDefineParameters(): void {
    this._lazyParameter = this.defineFlagParameter({
      parameterLongName: '--lazy',
      parameterShortName: '-l',
      description: 'Do not clean the "node_modules" folder before running "npm install".'
        + ' This is faster, but less correct, so only use it for debugging.'
    });
    this._forceParameter = this.defineFlagParameter({
      parameterLongName: '--force',
      parameterShortName: '-f',
      description: 'Forces cleaning of the node_modules folder before running "npm install".'
    });
  }

  protected onExecute(): void {
    this._rushConfiguration = RushConfiguration.loadFromDefaultLocation();

    const stopwatch: Stopwatch = Stopwatch.start();

    console.log('Starting "rush generate"' + os.EOL);

    if (this._rushConfiguration.packageReviewFile) {
        this._packageReviewChecker = new PackageReviewChecker(this._rushConfiguration);
        this._packageReviewChecker.saveCurrentDependencies();
    }

    // 1. Delete "common\temp_modules"
    GenerateAction._deleteCommonTempModules(this._rushConfiguration);

    // 2. Construct common\package.json and common\temp_modules
    const tempModules: Map<string, IPackageJson> =
      GenerateAction._createCommonTempModulesAndPackageJson(this._rushConfiguration);

    // 3. Detect if we need to do a full rebuild, or if the shrinkwrap already contains the
    //    necessary dependencies. This will happen if someone is adding a new rush dependency,
    //    or if someone is adding a dependency which already exists in another project

    const shouldDeleteNodeModules: boolean =
      GenerateAction._shouldDeleteNodeModules(this._rushConfiguration, tempModules);

    // 4. Delete "common\node_modules"
    GenerateAction._deleteCommonNodeModules(this._rushConfiguration,
      this._lazyParameter.value || !shouldDeleteNodeModules);

    if (shouldDeleteNodeModules || this._lazyParameter.value) {
      // 5. Delete the previous npm-shrinkwrap.json
      GenerateAction._deleteShrinkwrapFile(this._rushConfiguration);
    }

    // 6. Make sure the NPM tool is set up properly.  Usually "rush install" should have
    //    already done this, but not if they just cloned the repo
    console.log('');
    InstallAction.ensureLocalNpmTool(this._rushConfiguration, false);

    // 7. Run "npm install" and "npm shrinkwrap"
    // (always run, installing based on old shrinkwrap if temp_modules has changed but no need to create new shrinkwrap
    GenerateAction._runNpmInstall(this._rushConfiguration);

    if (shouldDeleteNodeModules) {
      GenerateAction._runNpmShrinkWrap(this._rushConfiguration, this._lazyParameter.value);
    }

    stopwatch.stop();
    console.log(os.EOL + colors.green(`Rush generate finished successfully. (${stopwatch.toString()})`));
    console.log(os.EOL + 'Next you should probably run: "rush link"');
  }
}
