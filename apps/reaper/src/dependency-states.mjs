export async function resolveFreshDependencyStates({ freshDependencies, mergedKeys, resolveLiveDependency }) {
  const dependencyStates = {};
  for (const dependency of freshDependencies) {
    dependencyStates[dependency] = mergedKeys.has(dependency)
      ? 'merged'
      : await resolveLiveDependency(dependency);
  }
  return dependencyStates;
}
