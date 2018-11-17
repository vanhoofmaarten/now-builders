const { createLambda } = require('@now/build-utils/lambda.js');
const download = require('@now/build-utils/fs/download.js');
const FileFsRef = require('@now/build-utils/file-fs-ref.js');
const FileBlob = require('@now/build-utils/file-blob');
const path = require('path');
const { readFile, writeFile, unlink } = require('fs.promised');
const rename = require('@now/build-utils/fs/rename.js');
const {
  runNpmInstall,
  runPackageJsonScript
} = require('@now/build-utils/fs/run-user-scripts.js');
const glob = require('@now/build-utils/fs/glob.js');

// Exclude certain files from the files object
function excludeFiles(files, matchFn) {
  return Object.keys(files).reduce((newFiles, fileName) => {
    if (matchFn(fileName)) {
      return newFiles;
    }
    return {
      ...newFiles,
      [fileName]: files[fileName]
    };
  }, {});
}

function shouldExcludeFile(entryDirectory) {
  return file => {
    // If the file is not in the entry directory
    if (entryDirectory !== '.' && !file.startsWith(entryDirectory)) {
      return true;
    }

    // Exclude static directory
    if (file.startsWith(path.join(entryDirectory, 'static'))) {
      return true;
    }

    if (file === 'package-lock.json') {
      return true;
    }

    if (file === 'yarn.lock') {
      return true;
    }

    return false;
  };
}

exports.build = async ({ files, workPath, entrypoint }) => {
  if (
    !/package\.json$/.exec(entrypoint) &&
    !/nuxt\.config\.js$/.exec(entrypoint)
  ) {
    throw new Error(
      'Specified "src" for "@now/nuxt" has to be "package.json" or "nuxt.config.js"'
    );
  }

  console.log('downloading user files...');
  const entryDirectory = path.dirname(entrypoint);
  const filesToDownload = excludeFiles(
    files,
    shouldExcludeFile(entryDirectory)
  );
  const entrypointHandledFilesToDownload = rename(filesToDownload, file => {
    if (entryDirectory !== '.') {
      return file.replace(new RegExp(`^${entryDirectory}/`), '');
    }
    return file;
  });
  let downloadedFiles = await download(
    entrypointHandledFilesToDownload,
    workPath
  );

  let packageJson = {};
  if (downloadedFiles['package.json']) {
    console.log('found package.json, overwriting');
    const packageJsonPath = downloadedFiles['package.json'].fsPath;
    packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  }

  packageJson = {
    ...packageJson,
    dependencies: {
      ...packageJson.dependencies,
      server: 'latest'
    },
    devDependencies: {
      ...packageJson.devDependencies,
      nuxt: 'latest'
    },
    scripts: {
      ...packageJson.scripts,
      'now-build': 'nuxt build'
    }
  };

  // in case the user has `nuxt` on their `dependencies`, we remove it
  delete packageJson.dependencies.nuxt;

  await writeFile(
    path.join(workPath, 'package.json'),
    JSON.stringify(packageJson, null, 2)
  );

  if (process.env.NPM_AUTH_TOKEN) {
    console.log('found NPM_AUTH_TOKEN in environment, creating .npmrc');
    await writeFile(
      path.join(workPath, '.npmrc'),
      `//registry.npmjs.org/:_authToken=${process.env.NPM_AUTH_TOKEN}`
    );
  }
  downloadedFiles = await glob('**', workPath);

  console.log('running npm install...');
  await runNpmInstall(workPath, ['--prefer-offline']);
  console.log('running user script...');
  await runPackageJsonScript(workPath, 'now-build');
  console.log('running npm install --production...');
  await runNpmInstall(workPath, ['--prefer-offline', '--production']);
  if (process.env.NPM_AUTH_TOKEN) {
    await unlink(path.join(workPath, '.npmrc'));
  }
  downloadedFiles = await glob('**', workPath);

  console.log('preparing lambda files...');
  const dotNuxtRootFiles = await glob('.nuxt/dist/*', workPath);
  const dotNuxtServerRootFiles = await glob('.nuxt/dist/server/*', workPath);
  const nodeModules = excludeFiles(
    await glob('node_modules/**', workPath),
    file => file.startsWith('node_modules/.cache')
  );
  const launcherFiles = {
    'now__bridge.js': new FileFsRef({ fsPath: require('@now/node-bridge') })
  };
  const nuxtFiles = {
    ...nodeModules,
    ...dotNuxtRootFiles,
    ...dotNuxtServerRootFiles,
    ...launcherFiles
  };
  if (downloadedFiles['nuxt.config.js']) {
    nuxtFiles['nuxt.config.js'] = downloadedFiles['nuxt.config.js'];
  }

  const parseRoutes = obj => Function(`"use strict";return ${obj}`)(); // eslint-disable-line no-new-func

  const getPages = async () => {
    const filePath = path.join(workPath, '.nuxt', 'router.js');
    const fileContent = await readFile(filePath, 'utf8');
    const regexRoutes = /routes:\s?(\[[\s\S]+[\w\W]+[\d\D]\])/gm;
    const matchRoutes = regexRoutes.exec(fileContent);
    const data = matchRoutes[1]
      .replace(/\s||\t\||\r||\n/g, '')
      .replace(/(component:\s?)([\s\S]*[\w\W]*[\d\D]*)(,)/gm, '$1""$3');

    const pages = parseRoutes(data);
    return pages;
  };

  const pages = await getPages();

  const launcherPath = path.join(__dirname, 'launcher.js');
  const launcherData = await readFile(launcherPath, 'utf8');

  const lambdas = {};
  await Promise.all(
    pages.map(async ({ path: pagePath, name: pageName }) => {
      const launcher = launcherData.replace('PATHNAME_PLACEHOLDER', pagePath);

      lambdas[path.join(entryDirectory, pageName)] = await createLambda({
        files: {
          ...nuxtFiles,
          'now__launcher.js': new FileBlob({ data: launcher })
        },
        handler: 'now__launcher.launcher',
        runtime: 'nodejs8.10'
      });
    })
  );

  const nuxtStaticFiles = await glob(
    '**',
    path.join(workPath, '.nuxt', 'dist', 'client')
  );
  const staticFiles = Object.keys(nuxtStaticFiles).reduce(
    (mappedFiles, file) => ({
      ...mappedFiles,
      [path.join(entryDirectory, `_nuxt/dist/client/${file}`)]: nuxtStaticFiles[
        file
      ]
    }),
    {}
  );

  return { ...lambdas, ...staticFiles };
};

exports.prepareCache = async ({ files, cachePath, workPath }) => {
  console.log('downloading user files...');
  await download(files, cachePath);
  await download(await glob('.nuxt/**', workPath), cachePath);
  await download(await glob('node_modules/**', workPath), cachePath);

  console.log('.next folder contents', await glob('.nuxt/**', cachePath));
  console.log(
    '.cache folder contents',
    await glob('node_modules/.cache/**', cachePath)
  );

  console.log('running npm install...');
  await runNpmInstall(cachePath);

  return {
    ...(await glob('.nuxt/records.json', cachePath)),
    ...(await glob('.nuxt/server/records.json', cachePath)),
    ...(await glob('node_modules/**', cachePath)),
    ...(await glob('yarn.lock', cachePath))
  };
};
