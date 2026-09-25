/** Resolve the same trusted per-Agent Skill scope used by native skill/read_file. */
async function resolveWorkspaceSkillId(configurable, name, methods) {
  if (typeof name !== 'string' || !name || !configurable) return null;

  const primed = configurable.skillPrimedIdsByName;
  const ids = configurable.accessibleSkillIds;
  if (primed && Object.hasOwn(primed, name)) {
    const id = primed[name];
    if (typeof id !== 'string' || !/^[0-9a-f]{24}$/.test(id)) return null;
    if (!Array.isArray(ids) || !ids.some((candidate) => candidate.toString() === id)) return null;
    const skill = await methods.getSkillById(id);
    return skill?.name === name ? skill._id.toString() : null;
  }

  const names = configurable.activeSkillNames;
  if (!(names instanceof Set) || !names.has(name) || !Array.isArray(ids) || ids.length === 0) {
    return null;
  }
  const skill = await methods.getSkillByName(name, ids, { preferModelInvocable: true });
  if (!skill || skill.disableModelInvocation === true) return null;
  const id = skill._id.toString();
  return ids.some((candidate) => candidate.toString() === id) ? id : null;
}

module.exports = { resolveWorkspaceSkillId };
