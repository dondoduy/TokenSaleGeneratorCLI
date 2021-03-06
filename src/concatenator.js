require('./utils.js')
const fs = require('fs')
const path = require('path')
const util = require('util')
const config = require('../config.js')
const PRAGAMA_SOLIDITY_VERSION_REGEX = /^\s*pragma\ssolidity\s+(.*?)\s*;/;
const SUPPORTED_VERSION_DECLARATION_REGEX = /^\^?\d+(\.\d+){1,2}$/;
const IMPORT_SOLIDITY_REGEX = /^.*import.*$/mg;
const tsort = require('tsort')

let { readFile, appendFile, deleteFile } = require('./helpers.js')

const SolidityParser = require('solidity-parser');

async function normalizeCompilerVersionDeclarations(files) {
  let pinnedVersion;
  let pinnedVersionFile;

  let maxCaretVersion;
  let maxCaretVersionFile;

  for (const file of files) {
    const version = await getFileCompilerVersionDeclaration(file);

    if (version === undefined) {
      continue;
    }

    if (version.startsWith("^")) {
      if (maxCaretVersion == undefined) {
        maxCaretVersion = version;
        maxCaretVersionFile = file;
      } else {
        if (semver.gt(version.substr(1), maxCaretVersion.substr(1))) {
          maxCaretVersion = version;
          maxCaretVersionFile = file;
        }
      }
    } else {
      if (pinnedVersion === undefined) {
        pinnedVersion = version;
        pinnedVersionFile = file;
      } else if (pinnedVersion !== version) {
        throw new Error(
          "Different pinned compiler versions in " +
            pinnedVersionFile +
            " and " +
            file
        );
      }
    }

    if (maxCaretVersion !== undefined && pinnedVersion !== undefined) {
      if (!semver.satisfies(pinnedVersion, maxCaretVersion)) {
        throw new Error(
          "Incompatible compiler version declarations in " +
            maxCaretVersionFile +
            " and " +
            pinnedVersionFile
        );
      }
    }
  }

  if (pinnedVersion !== undefined) {
    return pinnedVersion;
  }

  return maxCaretVersion;
}

async function getFileCompilerVersionDeclaration(fileContents) {

  const matched = fileContents.match(PRAGAMA_SOLIDITY_VERSION_REGEX);


  if (matched === null) {
    return undefined;
  }

  const version = matched[1];

  if (!SUPPORTED_VERSION_DECLARATION_REGEX.test(version)) {
    throw new Error("Unsupported compiler version declaration");
  }

  return version;
}

function getDirPath(filePath) {
  return filePath.substring(0, filePath.lastIndexOf(path.sep));
}

function getDependencies(filePath, fileContents) {
  const dependencies = [];
  let imports;

  try {
    imports = SolidityParser.parse(fileContents, "imports")
  } catch(error) {
    throw new Error(
      "Could not parse " + filePath + " for extracting its imports."
    );
  }

  for (let dependency of imports) {
    if (dependency.startsWith("./") || dependency.startsWith("../")) {
      dependency = getDirPath(filePath) + path.sep + dependency;
      dependency = path.normalize(dependency);
    }
    dependencies.push(dependency)
  }

  return dependencies
}

async function resolver(filePath) {

  if (!path.isAbsolute(filePath)) {
    filePath = path.join(process.cwd(), filePath)
  }

  let fileContents = await readFile(filePath, { encoding: 'utf8'})
  return {
    filePath: filePath,
    fileContents: fileContents
  }
}

async function getSortedDependencies(graph, visitedFiles, filePath) {
  visitedFiles.push(filePath);
  const file = await resolver(filePath)
  const dependencies = getDependencies(
    file.filePath,
    file.fileContents
  )

  for (let dependency of dependencies) {
    graph.add(dependency, filePath)
    const resolveDependency = await resolver(dependency)

    if (!visitedFiles.includes(dependency)) {
      await getSortedDependencies(graph, visitedFiles, dependency)
    }
  }
}

async function getSortedFilePaths(files) {
  const graph = tsort();
  const visitedFiles = [];

  for (const file of files) {
    await getSortedDependencies(graph, visitedFiles, file)
  }
  const sortedFiles = graph.sort();
  const sortedFilesWithEntries = sortedFiles.concat(sortedFiles)
  return sortedFilesWithEntries.unique()
}

async function writeConcatenation(files, filePath) {
  const version = await normalizeCompilerVersionDeclarations(files);

  if (version) {
    console.log('pragma solidity ' + version + ";");
  }

  for (const file of files) {
    let fileContents = await readFile(file, 'utf-8')
    fileContents = fileContents.replace(PRAGAMA_SOLIDITY_VERSION_REGEX, "")
                              .replace(IMPORT_SOLIDITY_REGEX, "")

    await appendFile(filePath, fileContents)
  }
}

async function concatenate(filePath) {
  let fileName = path.basename(filePath)
  let outputFilePath = path.join(config.flattenedContractsOutput, fileName)
  await deleteFile(outputFilePath)

  filePath = Array(filePath)
  const sortedFiles = await getSortedFilePaths(filePath)

  await writeConcatenation(sortedFiles, outputFilePath)
}

module.exports = {
  concatenate
}