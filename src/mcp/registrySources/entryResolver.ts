// 把 Registry 条目解析成可安装规格:remote 优先,其次锁定 npm/pypi 包。
import { buildLockedPackageLaunch } from './packageSpec.js';
import type {
  McpInstallSpec,
  McpRegistryEntry,
  McpRequiredInput,
  RawRegistryArgument,
  RawRegistryPackage,
  RawRegistryRemote,
  RawRegistryServer,
} from './types.js';

/**
 * 解析优先级:streamable-http remote(零本地安装) > 可精确锁定的 npm/pypi 包。
 * 模板参数(值里带 {placeholder})V1 不解析,直接判不可安装并说明原因。
 */
export function resolveRegistryEntry(raw: RawRegistryServer): McpRegistryEntry {
  const base = {
    name:        raw.name,
    title:       raw.title,
    description: raw.description,
    version:     raw.version,
    repositoryUrl: raw.repository?.url,
    websiteUrl:  raw.websiteUrl ?? raw.website_url,
  };

  const remote = (raw.remotes ?? []).find((r) => r.type === 'streamable-http' && r.url);
  if (remote) {
    return resolveRemote(base, remote);
  }

  const packages = raw.packages ?? [];
  for (const pkg of packages) {
    const spec = resolvePackage(pkg);
    if (spec) return { ...base, installable: true, ...spec };
  }

  if ((raw.remotes ?? []).length > 0) {
    return {
      ...base,
      installable: false,
      unavailableReason: '该条目只提供已弃用的 SSE 远程端点,未提供 Streamable HTTP',
    };
  }
  if (packages.some((pkg) => pkg.identifier || pkg.name)) {
    return {
      ...base,
      installable: false,
      unavailableReason: '包缺少受支持的 registry(npm/pypi)、合法包名或精确版本,已阻止未锁定安装',
    };
  }
  return { ...base, installable: false, unavailableReason: '条目没有可用的远程端点或包' };
}

function resolveRemote(
  base: Omit<McpRegistryEntry, 'installable'>,
  remote: RawRegistryRemote,
): McpRegistryEntry {
  const headers: Record<string, string> = {};
  const requiredInputs: McpRequiredInput[] = [];
  for (const header of remote.headers ?? []) {
    if (header.value !== undefined && !hasTemplate(header.value)) {
      headers[header.name] = header.value;
    } else if (header.is_required) {
      requiredInputs.push({
        key: header.name,
        target: 'header',
        isSecret: header.is_secret ?? true,
        description: header.description,
      });
    }
  }
  const spec: McpInstallSpec = {
    transport: 'http',
    url: remote.url,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
  return {
    ...base,
    installable: true,
    spec,
    ...(requiredInputs.length > 0 ? { requiredInputs } : {}),
  };
}

function resolvePackage(
  pkg: RawRegistryPackage,
): { spec: McpInstallSpec; requiredInputs?: readonly McpRequiredInput[] } | null {
  const registry = pkg.registryType ?? pkg.registry_type ?? pkg.registry_name;
  const identifier = pkg.identifier ?? pkg.name;
  const launch = buildLockedPackageLaunch(registry, identifier, pkg.version);
  if (!launch) return null;

  const args = [...launch.args];
  const extraArgs = [...(pkg.runtime_arguments ?? []), ...(pkg.package_arguments ?? [])];
  // 模板参数(含 {} 占位)需要安装期求值,V1 不支持;换下一个包。
  if (extraArgs.some((arg) => hasTemplate(arg.value ?? '') || hasTemplate(arg.name ?? ''))) {
    return null;
  }
  for (const arg of extraArgs) {
    const mapped = mapArgument(arg);
    if (!mapped) return null;
    args.push(...mapped);
  }

  const env: Record<string, string> = {};
  const requiredInputs: McpRequiredInput[] = [];
  for (const envVar of pkg.environment_variables ?? []) {
    if (envVar.default !== undefined) {
      env[envVar.name] = envVar.default;
    } else if (envVar.is_required) {
      requiredInputs.push({
        key: envVar.name,
        target: 'env',
        isSecret: envVar.is_secret ?? true,
        description: envVar.description,
      });
    }
  }

  return {
    spec: {
      transport: 'stdio',
      command: launch.command,
      args,
      ...(Object.keys(env).length > 0 ? { env } : {}),
    },
    ...(requiredInputs.length > 0 ? { requiredInputs } : {}),
  };
}

function mapArgument(arg: RawRegistryArgument): string[] | null {
  if (arg.type === 'positional') {
    return arg.value !== undefined ? [arg.value] : null;
  }
  // named:有值给 --name=value,无值视为 flag。
  if (!arg.name) return null;
  const flag = arg.name.startsWith('--') ? arg.name : `--${arg.name}`;
  return arg.value !== undefined ? [`${flag}=${arg.value}`] : [flag];
}

function hasTemplate(value: string): boolean {
  return /\{[^}]*\}/.test(value);
}
