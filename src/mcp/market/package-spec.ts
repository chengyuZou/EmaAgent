// 这里校验市场包的 registry、名称和精确版本，并生成不可漂移的启动参数。

export type McpPackageRegistry = 'npm' | 'pypi';

export interface LockedPackageLaunch {
  registry: McpPackageRegistry;
  packageName: string;
  packageVersion: string;
  command: 'npx' | 'uvx';
  args: string[];
}

const EXACT_VERSION_RE = /^[0-9][0-9A-Za-z._+-]{0,127}$/;
const FLOATING_VERSION_SEGMENT_RE = /(?:^|[._-])[xX](?:$|[._+-])/;
const NPM_PACKAGE_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const PYPI_PACKAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function buildLockedPackageLaunch(
  registry: string | undefined,
  packageName: string | undefined,
  packageVersion: string | undefined,
): LockedPackageLaunch | null {
  if (!registry || !packageName || !packageVersion) return null;
  if (
    !EXACT_VERSION_RE.test(packageVersion)
    || FLOATING_VERSION_SEGMENT_RE.test(packageVersion)
  ) return null;

  const normalizedRegistry = registry.toLowerCase();
  if (normalizedRegistry === 'npm' && NPM_PACKAGE_RE.test(packageName)) {
    return {
      registry: 'npm',
      packageName,
      packageVersion,
      command: 'npx',
      args: ['-y', `${packageName}@${packageVersion}`],
    };
  }
  if (normalizedRegistry === 'pypi' && PYPI_PACKAGE_RE.test(packageName)) {
    return {
      registry: 'pypi',
      packageName,
      packageVersion,
      command: 'uvx',
      args: [`${packageName}==${packageVersion}`],
    };
  }
  return null;
}
