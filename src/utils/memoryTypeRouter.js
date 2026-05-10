/**
 * Memory Type Router v1.0 — maps memory_type to section + write mode
 * Used by memory_upsert when memory_type is provided without explicit section.
 * @module utils/memoryTypeRouter
 */

const ROUTING_TABLE = {
    credential:       { section: 'CREDENTIAL',          mode: 'append_to_section' },
    exploit_success:  { section: 'EXPLOIT',             mode: 'append_to_section', dual_save: true },
    exploit_failure:  { section: 'GAGAL',               mode: 'append_to_section', dual_save: true },
    status:           { section: 'LIVE STATUS',          mode: 'replace_section' },
    recon:            { section: 'RECON',                mode: 'append_to_section' },
    todo:             { section: 'RE-ENTRY CHECKLIST',   mode: 'replace_section' },
    blocker:          { section: 'RE-ENTRY CHECKLIST',   mode: 'append_to_section' },
    command:          { section: 'EXPLOIT',              mode: 'append_to_section' },
    lesson:           { section: 'EXPLOIT',              mode: 'append_to_section' },
    decision:         { section: 'LIVE STATUS',          mode: 'append_to_section' },
    environment:      { section: 'RECON',                mode: 'append_to_section' },
};

const VALID_TYPES = Object.keys(ROUTING_TABLE);

export function routeMemoryType(memoryType) {
    if (!memoryType) return null;
    const key = memoryType.toLowerCase().trim();
    const route = ROUTING_TABLE[key];
    if (!route) {
        return { error: `Unknown memory_type "${memoryType}". Valid types: ${VALID_TYPES.join(', ')}` };
    }
    return { ...route, memory_type: key };
}

export function getValidTypes() {
    return VALID_TYPES;
}

export default { routeMemoryType, getValidTypes };
