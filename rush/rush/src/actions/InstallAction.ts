// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as colors from 'colors';
import * as fsx from 'fs-extra';
import * as glob from 'glob';
import globEscape = require('glob-escape');
import * as os from 'os';
import * as path from 'path';
import * as _ from 'lodash';

import { CommandLineAction, CommandLineFlagParameter } from '@microsoft/ts-command-line';
import {
  JsonFile,
  RushConfiguration,
  RushConfigurationProject,
  Utilities,
  Stopwatch,
  AsyncRecycle,
  IPackageJson
} from '@microsoft/rush-lib';

import RushCommandLineParser from './RushCommandLineParser';
import GitPolicy from '../utilities/GitPolicy';
import { TempModuleGenerator } from '../utilities/TempModuleGenerator';

const MAX_INSTALL_ATTEMPTS: number = 5;

interface ITempModuleInformation {
  packageJson: IPackageJson;
  existsInProjectConfiguration: boolean;
  filename: string;
}

export default class InstallAction extends CommandLineAction {
  private _parser: RushCommandLineParser;
  private _rushConfiguration: RushConfiguration;
  private _cleanInstall: CommandLineFlagParameter;
  private _cleanInstallFull: CommandLineFlagParameter;
  private _bypassPolicy: CommandLineFlagParameter;

  private _tempModulesFiles: string[] = [];

  public static ensureLocalNpmTool(rushConfiguration: RushConfiguration, cleanInstall: boolean): void {
    // Example: "C:\Users\YourName\.rush"
    const rushHomeFolder: string = path.join(rushConfiguration.homeFolder, '.rush');

    if (!fsx.existsSync(rushHomeFolder)) {
      console.log('Creating ' + rushHomeFolder);
      fsx.mkdirSync(rushHomeFolder);
    }

    // Example: "C:\Users\YourName\.rush\npm-1.2.3"
    const npmToolFolder: string = path.join(rushHomeFolder, 'npm-' + rushConfiguration.npmToolVersion);
    // Example: "C:\Users\YourName\.rush\npm-1.2.3\last-install.flag"
    const npmToolFlagFile: string = path.join(npmToolFolder, 'last-install.flag');

    // NOTE: We don't care about the timestamp for last-install.flag, because nobody will change
    // the package.json for this case
    if (cleanInstall || !fsx.existsSync(npmToolFlagFile)) {
      console.log(colors.bold('Installing NPM version ' + rushConfiguration.npmToolVersion) + os.EOL);

      if (fsx.existsSync(npmToolFolder)) {
        console.log('Deleting old files from ' + npmToolFolder);
        Utilities.dangerouslyDeletePath(npmToolFolder);
      }
      Utilities.createFolderWithRetry(npmToolFolder);

      const npmPackageJson: PackageJson = {
        dependencies: { 'npm': rushConfiguration.npmToolVersion },
        description: 'Temporary file generated by the Rush tool',
        name: 'npm-local-install',
        private: true,
        version: '0.0.0'
      };
      JsonFile.saveJsonFile(npmPackageJson, path.join(npmToolFolder, 'package.json'));

      console.log(os.EOL + 'Running "npm install" in ' + npmToolFolder);

      // NOTE: Here we use whatever version of NPM we happen to find in the PATH
      Utilities.executeCommandWithRetry('npm', ['install'], MAX_INSTALL_ATTEMPTS, npmToolFolder);

      // Create the marker file to indicate a successful install
      fsx.writeFileSync(npmToolFlagFile, '');
      console.log('Successfully installed NPM ' + rushConfiguration.npmToolVersion);
    } else {
      console.log('Found NPM version ' + rushConfiguration.npmToolVersion + ' in ' + npmToolFolder);
    }

    // Example: "C:\MyRepo\common\npm-local"
    const localNpmToolFolder: string = path.join(rushConfiguration.commonFolder, 'npm-local');
    if (fsx.existsSync(localNpmToolFolder)) {
      fsx.unlinkSync(localNpmToolFolder);
    }
    console.log(os.EOL + 'Symlinking "' + localNpmToolFolder + '"');
    console.log('  --> "' + npmToolFolder + '"');
    fsx.symlinkSync(npmToolFolder, localNpmToolFolder, 'junction');
  }

  constructor(parser: RushCommandLineParser) {
    super({
      actionVerb: 'install',
      summary: 'Install NPM packages as specified by the configuration files in the Rush "common" folder',
      documentation: 'Use this command after pulling new changes from git into your working folder.'
        + ' It will download and install the appropriate NPM packages needed to build your projects.'
        + ' The complete sequence is as follows:  1. If not already installed, install the'
        + ' version of the NPM tool that is specified in the rush.json configuration file.  2. Create the'
        + ' common/npm-local symlink, which points to the folder from #1.  3. If necessary, run'
        + ' "npm prune" in the Rush common folder.  4. If necessary, run "npm install" in the'
        + ' Rush common folder.'
    });
    this._parser = parser;
  }

  protected onDefineParameters(): void {
    this._cleanInstall = this.defineFlagParameter({
      parameterLongName: '--clean',
      parameterShortName: '-c',
      description: 'Delete any previously installed files before installing;'
      + ' this takes longer but will resolve data corruption that is often'
      + ' encountered with the NPM tool'
    });
    this._cleanInstallFull = this.defineFlagParameter({
      parameterLongName: '--full-clean',
      parameterShortName: '-C',
      description: 'Like "--clean", but also deletes and reinstalls the NPM tool itself'
    });
    this._bypassPolicy = this.defineFlagParameter({
      parameterLongName: '--bypass-policy',
      description: 'Overrides gitPolicy enforcement (use honorably!)'
    });
  }

  protected onExecute(): void {
    this._rushConfiguration = RushConfiguration.loadFromDefaultLocation();

    if (!this._bypassPolicy.value) {
      if (!GitPolicy.check(this._rushConfiguration)) {
        process.exit(1);
        return;
      }
    }

    const stopwatch: Stopwatch = Stopwatch.start();

    console.log('Starting "rush install"' + os.EOL);

    // Example: "C:\MyRepo\common\temp_modules\rush-example-project\package.json"
    const normalizedPath: string = Utilities.getAllReplaced(this._rushConfiguration.tempModulesFolder, '\\', '/');
    const globPattern: string = `${globEscape(normalizedPath)}/rush-*/package.json`;
    this._tempModulesFiles = glob.sync(globPattern, { nodir: true });

    this._checkThatTempModulesMatch();

    InstallAction.ensureLocalNpmTool(this._rushConfiguration, this._cleanInstallFull.value);
    this._installCommonModules();

    stopwatch.stop();
    console.log(colors.green(`The common NPM packages are up to date. (${stopwatch.toString()})`));
    console.log(os.EOL + 'Next you should probably run: "rush link"');
  }

  private _checkThatTempModulesMatch(): void {
    // read all temp_modules
    const tempModules: { [packageName: string]: ITempModuleInformation } = {};

    this._tempModulesFiles.forEach((filename) => {
      const contents: IPackageJson = require(filename);
      tempModules[contents.name] = {
        packageJson: contents,
        existsInProjectConfiguration: false,
        filename: filename
      };
    });

    // 1st ensure that every temp_module exists in the configuration
    Object.keys(tempModules).forEach((tempModuleName: string) => {
      const tempModule: ITempModuleInformation = tempModules[tempModuleName];

      let foundMatchingProject: boolean;
      this._rushConfiguration.projects.forEach((project: RushConfigurationProject) => {
        if (project.tempProjectName === tempModuleName) {
          foundMatchingProject = true;
        }
      });

      if (!foundMatchingProject) {
        throw new Error(`The file "${tempModule.filename}" exists in the temp_modules folder ` +
          `but we could not find a matching project for it. This file may need to be deleted.` +
          `\n\nDid you forget to run 'rush generate'?`);
      }
    });

    const expectedTempModules: Map<string, IPackageJson> = new TempModuleGenerator(this._rushConfiguration).tempModules;

    // 2nd ensure that each config project has a temp_module which matches the expected value
    this._rushConfiguration.projects.forEach((project: RushConfigurationProject) => {
      //   if no temp_module, throw

      const tempModule: ITempModuleInformation
        = tempModules[project.tempProjectName];
      if (!tempModule) {
        throw new Error(`The project ${project.packageName} is missing a corresponding ` +
          `file in the temp_modules folder.` +
          `\n\nDid you forget to run 'rush generate'?`);
      }

      // Generate an expected temp_modules package.json & compare
      const expectedTempModule: IPackageJson = expectedTempModules.get(project.packageName);

      if (!_.isEqual(expectedTempModule, tempModule.packageJson)) {
        // wordwrap attempts to remove any leading spaces, however, we are attempting to serialize
        // some JSON information into the error, and therefore we want to maintain proper spacing.
        // the workaround is to wrap our spaces in the non-breaking character

        const errorMsg: string = `The project ${project.packageName}'s temp_module is outdated`;
        const rerunGenerate: string = '\nDid you forget to run rush generate?';

        console.log(colors.red(`${errorMsg}:\n`));
        console.log(colors.red(`EXPECTED:\n${JSON.stringify(expectedTempModule, undefined, 2)}\n`));
        console.log(colors.red(`ACTUAL: \n${JSON.stringify(tempModule.packageJson, undefined, 2)}`));

        throw new Error(errorMsg + '\n' + rerunGenerate);
      }
    });
  }

  private _installCommonModules(): void {
    // Example: "C:\MyRepo\common\npm-local\node_modules\.bin\npm"
    const npmToolFilename: string = this._rushConfiguration.npmToolFilename;
    if (!fsx.existsSync(npmToolFilename)) {
      // This is a sanity check.  It should never happen if the above logic worked correctly.
      throw new Error('Failed to create "' + npmToolFilename + '"');
    }

    console.log(os.EOL + colors.bold('Checking modules in ' + this._rushConfiguration.commonFolder) + os.EOL);

    // Example: "C:\MyRepo\common\last-install.flag"
    const commonNodeModulesMarkerFilename: string =
      path.join(this._rushConfiguration.commonFolder, 'last-install.flag');
    const commonNodeModulesFolder: string = path.join(this._rushConfiguration.commonFolder, 'node_modules');

    let needToInstall: boolean = false;
    let skipPrune: boolean = false;

    if (this._cleanInstall.value || this._cleanInstallFull.value) {
      if (fsx.existsSync(commonNodeModulesMarkerFilename)) {
        // If we are cleaning the node_modules folder, then also delete the flag file
        // to force a reinstall
        fsx.unlinkSync(commonNodeModulesMarkerFilename);
      }

      // Example: "C:\MyRepo\common\node_modules"
      if (fsx.existsSync(commonNodeModulesFolder)) {
        console.log('Deleting old files from ' + commonNodeModulesFolder);
        Utilities.dangerouslyDeletePath(commonNodeModulesFolder);
        Utilities.createFolderWithRetry(commonNodeModulesFolder);
      }

      if (this._rushConfiguration.cacheFolder) {
        const cacheCleanArgs: string[] = ['cache', 'clean', this._rushConfiguration.cacheFolder];
        console.log(os.EOL + `Running "npm ${cacheCleanArgs.join(' ')}"`);
        Utilities.executeCommand(npmToolFilename, cacheCleanArgs, this._rushConfiguration.commonFolder);
      } else {
        // Ideally we should clean the global cache here.  However, the global NPM cache
        // is (inexplicably) not threadsafe, so if there are any concurrent "npm install"
        // processes running this would cause them to crash.
        console.log(os.EOL + 'Skipping "npm cache clean" because the cache is global.');
      }

      needToInstall = true;
      skipPrune = true;
    } else {
      // Compare the timestamps last-install.flag and package.json to see if our install is outdated
      const packageJsonFilenames: string[] = [];

      // Example: "C:\MyRepo\common\package.json"
      packageJsonFilenames.push(path.join(this._rushConfiguration.commonFolder, 'package.json'));

      // Also consider the timestamp on the node_modules folder; if someone tampered with it
      // or deleted it entirely, then isFileTimestampCurrent() will cause us to redo "npm install".
      packageJsonFilenames.push(commonNodeModulesFolder);

      // Make sure we look at all the temp_modules/*/package.json files as well
      packageJsonFilenames.push(...this._tempModulesFiles);

      if (!Utilities.isFileTimestampCurrent(commonNodeModulesMarkerFilename, packageJsonFilenames)) {
        needToInstall = true;
      }
    }

    if (needToInstall) {
      // The "npm install" command is not transactional; if it is killed, then the "node_modules"
      // folder may be in a corrupted state (e.g. because a postinstall script only executed partially).
      // Rush works around this using a marker file "last-install.flag".  We delete this file
      // before installing, and then create it again after a successful "npm install".  Thus,
      // if this file exists, it guarantees we are in a good state.  If not, we must do a clean intall.
      if (!fsx.existsSync(commonNodeModulesMarkerFilename)) {
        if (fsx.existsSync(commonNodeModulesFolder)) {
          // If an "npm install" is interrupted,
          console.log('Deleting the "node_modules" folder because the previous Rush install' +
                      ' did not complete successfully.');

          AsyncRecycle.recycleDirectory(this._rushConfiguration, commonNodeModulesFolder);
        }

        skipPrune = true;
      } else {
        // Delete the successful install file to indicate the install has started
        fsx.unlinkSync(commonNodeModulesMarkerFilename);
      }

      if (!skipPrune) {
        console.log(`Running "npm prune" in ${this._rushConfiguration.commonFolder}`);
        Utilities.executeCommandWithRetry(npmToolFilename, ['prune'], MAX_INSTALL_ATTEMPTS,
          this._rushConfiguration.commonFolder);

        // Delete the temp projects because NPM will not notice when they are changed.
        // We can recognize them because their names start with "rush-"

        // Example: "C:\MyRepo\common\node_modules\rush-"
        const pathToDeleteWithoutStar: string = path.join(commonNodeModulesFolder, 'rush-');
        console.log(`Deleting ${pathToDeleteWithoutStar}*`);
        // Glob can't handle Windows paths
        const normalizedpathToDeleteWithoutStar: string
          = Utilities.getAllReplaced(pathToDeleteWithoutStar, '\\', '/');
        for (const tempModulePath of glob.sync(globEscape(normalizedpathToDeleteWithoutStar) + '*')) {
          Utilities.dangerouslyDeletePath(tempModulePath);
        }
      }

      const npmInstallArgs: string[] = [ 'install' ];
      if (this._rushConfiguration.cacheFolder) {
        npmInstallArgs.push('--cache', this._rushConfiguration.cacheFolder);
      }

      if (this._rushConfiguration.tmpFolder) {
        npmInstallArgs.push('--tmp', this._rushConfiguration.tmpFolder);
      }

      // Next, run "npm install" in the common folder
      console.log(os.EOL + `Running "npm ${npmInstallArgs.join(' ')}" in ${this._rushConfiguration.commonFolder}`);
      Utilities.executeCommandWithRetry(npmToolFilename,
                                        npmInstallArgs,
                                        MAX_INSTALL_ATTEMPTS,
                                        this._rushConfiguration.commonFolder);

      // Create the marker file to indicate a successful install
      fsx.createFileSync(commonNodeModulesMarkerFilename);
      console.log('');
    }

  }
}
