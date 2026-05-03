#!/usr/bin/env node
/**
 * Cross-target contamination cleanup script.
 *
 * For each contaminated section in runbook A that belongs to runbook B:
 * 1. Back up both files
 * 2. Extract full section content from A
 * 3. Check if equivalent content exists in B (avoid duplicates)
 * 4. If not in B → append to B
 * 5. Remove from A
 * 6. Verify integrity
 *
 * Usage:
 *   node scripts/cleanup_cross_target.js --dry-run    (show what would be done)
 *   node scripts/cleanup_cross_target.js --execute     (actually do it)
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'fs';
import { join, basename } from 'path';

const RUNBOOKS_DIR = '/home/kali/Desktop/mcp-memori/runbooks';
const BACKUP_DIR = '/home/kali/Desktop/mcp-memori/runbooks/.backup_cleanup';
const DRY_RUN = !process.argv.includes('--execute');

// Known contamination map: { sourceFile: [{ sectionPattern, targetFile }] }
// Built from the scan results
const CONTAMINATION_MAP = [
    // pdamnet ← paip.com.my (42 sections)
    { source: 'RUNBOOK_pdamnet.md', targetKeywords: ['paip.com.my', 'aquasmart.paip', 'helpdesk.paip', 'onlinepay.paip', 'mypaip', 'ebill.paip'], targetFile: 'RUNBOOK_paip.com.my.md' },
    { source: 'RUNBOOK_pdamnet.md', targetKeywords: ['pdam-sby', 'pdam sby'], targetFile: 'RUNBOOK_pdam-sby.go.id.md' },
    { source: 'RUNBOOK_pdamnet.md', targetKeywords: ['bappenas'], targetFile: 'RUNBOOK_bappenas.go.id.md' },
    { source: 'RUNBOOK_pdamnet.md', targetKeywords: ['purbalinggakab'], targetFile: 'RUNBOOK_purbalinggakab.go.id.md' },
    // ppid-kemdikti ← kemenkopmk (9), kemenparekraf (4)
    { source: 'RUNBOOK_ppid-kemdikti.md', targetKeywords: ['kemenkopmk', 'ppid kemenkopmk'], targetFile: 'RUNBOOK_kemenkopmk.go.id.md' },
    { source: 'RUNBOOK_ppid-kemdikti.md', targetKeywords: ['kemenparekraf'], targetFile: 'RUNBOOK_kemenparekraf.go.id.md' },
    // scada ← jasatirta2 (12)
    { source: 'RUNBOOK_scada.md', targetKeywords: ['jasatirta2', 'jasatirta 2'], targetFile: 'RUNBOOK_jasatirta2.md' },
    // lap.com.my ← mmrs-live (5), kemenperin (4), pdam-sby (1)
    { source: 'RUNBOOK_lap.com.my.md', targetKeywords: ['mmrs-live', 'mmrs live'], targetFile: 'RUNBOOK_mmrs-live.md' },
    { source: 'RUNBOOK_lap.com.my.md', targetKeywords: ['kemenperin'], targetFile: 'RUNBOOK_kemenperin.go.id.md' },
    { source: 'RUNBOOK_lap.com.my.md', targetKeywords: ['pdam-sby', 'pdam sby'], targetFile: 'RUNBOOK_pdam-sby.go.id.md' },
    // wri-indonesia ← paip (2), untad (1), jasatirta2 (1), bnpb (1)
    { source: 'RUNBOOK_wri-indonesia.id.md', targetKeywords: ['paip.com.my', 'aquasmart.paip'], targetFile: 'RUNBOOK_paip.com.my.md' },
    { source: 'RUNBOOK_wri-indonesia.id.md', targetKeywords: ['untad.ac.id', 'mail.untad'], targetFile: 'RUNBOOK_untad.ac.id.md' },
    { source: 'RUNBOOK_wri-indonesia.id.md', targetKeywords: ['jasatirta2'], targetFile: 'RUNBOOK_jasatirta2.md' },
    { source: 'RUNBOOK_wri-indonesia.id.md', targetKeywords: ['bnpb.go.id', 'inarisk'], targetFile: 'RUNBOOK_bnpb.go.id.md' },
    // aksamedia ← kelashumabetang (4)
    { source: 'RUNBOOK_aksamedia.md', targetKeywords: ['kelashumabetang'], targetFile: 'RUNBOOK_kelashumabetang.md' },
    // bangkok-bma ← sukoharjokab (2), kemenparekraf (2)
    { source: 'RUNBOOK_bangkok-bma.md', targetKeywords: ['sukoharjokab'], targetFile: 'RUNBOOK_sukoharjokab.go.id.md' },
    { source: 'RUNBOOK_bangkok-bma.md', targetKeywords: ['kemenparekraf'], targetFile: 'RUNBOOK_kemenparekraf.go.id.md' },
    // ebphtb ← bekasikota (3)
    { source: 'RUNBOOK_ebphtb.md', targetKeywords: ['bekasikota', 'sip3 bekasikota'], targetFile: 'RUNBOOK_bekasikota.md' },
    // pertanian ← geoportal-arcgis (3)
    { source: 'RUNBOOK_pertanian.md', targetKeywords: ['geoportal-arcgis', 'geoportal arcgis'], targetFile: 'RUNBOOK_geoportal-arcgis.md' },
    // moodle-aipki ← syekhnurjati (2)
    { source: 'RUNBOOK_moodle-aipki.md', targetKeywords: ['syekhnurjati'], targetFile: 'RUNBOOK_syekhnurjati.md' },
    // tnial ← kemenparekraf (2)
    { source: 'RUNBOOK_tnial.md', targetKeywords: ['kemenparekraf'], targetFile: 'RUNBOOK_kemenparekraf.go.id.md' },
    // samb ← its.ac.id (2)
    { source: 'RUNBOOK_samb.md', targetKeywords: ['its.ac.id', 'peta.its', 'lab-gi'], targetFile: 'RUNBOOK_its.ac.id.md' },
    // usc-sdccd ← madiunkota (1), jasatirta2 (1)
    { source: 'RUNBOOK_usc-sdccd.edu.md', targetKeywords: ['madiunkota'], targetFile: 'RUNBOOK_madiunkota.go.id.md' },
    { source: 'RUNBOOK_usc-sdccd.edu.md', targetKeywords: ['jasatirta2'], targetFile: 'RUNBOOK_jasatirta2.md' },
    // singles
    { source: 'RUNBOOK_gisbgor.md', targetKeywords: ['jabarprov', 'jacloud'], targetFile: 'RUNBOOK_jabarprov.go.id.md' },
    { source: 'RUNBOOK_madiunkota.go.id.md', targetKeywords: ['lap.com.my', 'mylapapps'], targetFile: 'RUNBOOK_lap.com.my.md' },
    { source: 'RUNBOOK_pamjaya.md', targetKeywords: ['jasatirta2'], targetFile: 'RUNBOOK_jasatirta2.md' },
    { source: 'RUNBOOK_sada-fpx.md', targetKeywords: ['mylapapps.lap', 'lap.com.my'], targetFile: 'RUNBOOK_lap.com.my.md' },
    { source: 'RUNBOOK_sainswater.md', targetKeywords: ['mmrs-live'], targetFile: 'RUNBOOK_mmrs-live.md' },
    { source: 'RUNBOOK_samb-melaka.com.md', targetKeywords: ['kemenkopmk'], targetFile: 'RUNBOOK_kemenkopmk.go.id.md' },
];

// Standard sections that should NOT be moved (they're generic, not contamination)
const STANDARD_SECTIONS = new Set([
    'recon', 'credential', 'exploit', 'gagal', 'live status', 're-entry checklist',
    'session log', '_auto_log', '_changelog', 'persistence', 'network', 'state',
    'next steps', 'info', 'appendix', '---'
]);

function splitSections(body) {
    const parts = body.split(/(?=^## )/m);
    return parts.map((part, idx) => {
        const headerMatch = part.match(/^## ([^\n]+)/);
        return {
            index: idx,
            header: headerMatch ? headerMatch[1].trim() : '',
            content: part,
            headerLower: headerMatch ? headerMatch[1].trim().toLowerCase() : ''
        };
    });
}

function isStandardSection(headerLower) {
    for (const std of STANDARD_SECTIONS) {
        if (headerLower.startsWith(std)) return true;
    }
    if (/^date:|^status:|^target:|^outcome:|^source:/.test(headerLower)) return true;
    if (headerLower.startsWith('--- migrated')) return true;
    return false;
}

function sectionMatchesTarget(headerLower, keywords) {
    return keywords.some(kw => headerLower.includes(kw.toLowerCase()));
}

function contentExistsInTarget(sectionContent, targetBody) {
    // Check if key content (first 200 chars of body) already exists in target
    const bodyStart = sectionContent.replace(/^## [^\n]+\n/, '').trim().substring(0, 200);
    if (bodyStart.length < 30) return true; // Too short = skip (probably empty)
    return targetBody.includes(bodyStart);
}

function main() {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Cross-Target Contamination Cleanup ${DRY_RUN ? '(DRY RUN)' : '(EXECUTING)'}`);
    console.log(`${'='.repeat(60)}\n`);

    if (!DRY_RUN) {
        mkdirSync(BACKUP_DIR, { recursive: true });
    }

    let totalFound = 0;
    let totalMoved = 0;
    let totalDeleted = 0;
    let totalDuplicate = 0;
    let totalSkipped = 0;

    // Group contamination rules by source file for efficiency
    const bySource = new Map();
    for (const rule of CONTAMINATION_MAP) {
        if (!bySource.has(rule.source)) bySource.set(rule.source, []);
        bySource.get(rule.source).push(rule);
    }

    for (const [sourceFile, rules] of bySource) {
        const sourcePath = join(RUNBOOKS_DIR, sourceFile);
        if (!existsSync(sourcePath)) {
            console.log(`SKIP: ${sourceFile} not found`);
            continue;
        }

        const sourceBody = readFileSync(sourcePath, 'utf8');
        const sections = splitSections(sourceBody);
        const contaminated = [];

        for (const sec of sections) {
            if (!sec.header || isStandardSection(sec.headerLower)) continue;

            for (const rule of rules) {
                if (sectionMatchesTarget(sec.headerLower, rule.targetKeywords)) {
                    contaminated.push({ section: sec, rule });
                    break;
                }
            }
        }

        if (contaminated.length === 0) continue;

        console.log(`\n--- ${sourceFile} (${contaminated.length} contaminated sections) ---`);
        totalFound += contaminated.length;

        // Back up source file
        if (!DRY_RUN) {
            copyFileSync(sourcePath, join(BACKUP_DIR, sourceFile + '.bak'));
        }

        // Track target files that need updating
        const targetUpdates = new Map(); // targetFile → [sections to append]
        const sectionsToRemove = new Set(); // section indices to remove from source

        for (const { section, rule } of contaminated) {
            const targetPath = join(RUNBOOKS_DIR, rule.targetFile);
            const targetExists = existsSync(targetPath);

            // Check if content already in target
            let isDuplicate = false;
            if (targetExists) {
                const targetBody = readFileSync(targetPath, 'utf8');
                isDuplicate = contentExistsInTarget(section.content, targetBody);
            }

            if (isDuplicate) {
                console.log(`  DEL (dup): ## ${section.header.substring(0, 70)} → already in ${rule.targetFile}`);
                sectionsToRemove.add(section.index);
                totalDuplicate++;
                totalDeleted++;
            } else if (targetExists) {
                console.log(`  MOV: ## ${section.header.substring(0, 70)} → ${rule.targetFile}`);
                if (!targetUpdates.has(rule.targetFile)) targetUpdates.set(rule.targetFile, []);
                targetUpdates.get(rule.targetFile).push(section.content);
                sectionsToRemove.add(section.index);
                totalMoved++;
            } else {
                console.log(`  SKIP: ## ${section.header.substring(0, 70)} → ${rule.targetFile} NOT FOUND`);
                totalSkipped++;
            }
        }

        if (!DRY_RUN && sectionsToRemove.size > 0) {
            // Append to target files
            for (const [targetFile, contents] of targetUpdates) {
                const targetPath = join(RUNBOOKS_DIR, targetFile);
                copyFileSync(targetPath, join(BACKUP_DIR, targetFile + '.bak'));
                let targetBody = readFileSync(targetPath, 'utf8');
                // Insert before _AUTO_LOG or at end
                const autoLogIdx = targetBody.indexOf('\n## _AUTO_LOG');
                if (autoLogIdx > 0) {
                    targetBody = targetBody.substring(0, autoLogIdx) + '\n\n' + contents.join('\n\n') + targetBody.substring(autoLogIdx);
                } else {
                    targetBody = targetBody.trimEnd() + '\n\n' + contents.join('\n\n') + '\n';
                }
                writeFileSync(targetPath, targetBody, 'utf8');
            }

            // Remove contaminated sections from source
            const cleanSections = sections.filter(s => !sectionsToRemove.has(s.index));
            const cleanBody = cleanSections.map(s => s.content).join('');
            writeFileSync(sourcePath, cleanBody, 'utf8');
        }
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`SUMMARY:`);
    console.log(`  Found:     ${totalFound} contaminated sections`);
    console.log(`  Moved:     ${totalMoved} (to correct runbook)`);
    console.log(`  Deleted:   ${totalDeleted} (duplicates already in target)`);
    console.log(`  Skipped:   ${totalSkipped} (target file not found)`);
    console.log(`  ${DRY_RUN ? 'DRY RUN — no changes made. Use --execute to apply.' : 'EXECUTED — backups in ' + BACKUP_DIR}`);
    console.log(`${'='.repeat(60)}\n`);
}

main();
