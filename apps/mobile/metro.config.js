const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

/**
 * Metro в монорепо: пакеты лежат вне apps/mobile, поэтому их надо явно
 * добавить в наблюдаемые папки и в пути поиска модулей. Иначе изменения
 * в packages/* не подхватываются, а импорты не резолвятся.
 */
const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
// Иначе Metro поднимается вверх по дереву и может взять чужую копию react.
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
