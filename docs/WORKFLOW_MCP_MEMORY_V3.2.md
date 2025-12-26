# WORKFLOW MCP MEMORY FINAL (PRODUCTION RULESET)

**Versi:** 3.2-PRODUCTION  
**Status:** TERBUKTI dari Ultimate Test (12/12 PASS, +220% Benchmark)

---

## 0) Konstanta Wajib

- `project_id` harus **SAMA** untuk semua sesi dan semua model AI.
- Semua jawaban teknis/aksi harus berbasis MCP Memory (bukan asumsi chat).
- Semua error/kesalahan harus ditangani via governance (feedback + maintain).

---

## STEP 0 — HARMONISASI STATE (Wajib di awal & sebelum keputusan besar)

### Kapan wajib dijalankan:
- ✅ Awal sesi
- ✅ Ganti topik / scope
- ✅ Sebelum memberi instruksi teknis penting
- ✅ Saat ada tanda lupa / kontradiksi / user bilang "kok ngulang"

```javascript
memory_summarize({ project_id })
```

### Wajib baca output:
| Field | Fungsi |
|-------|--------|
| `state_latest` | progres + TODO |
| `key_decisions` | keputusan aktif |
| `user_preferences` | preferensi user |
| `guardrails` | ⚠️ peringatan kesalahan |
| `excluded_items` / `excluded[]` | 🚫 item terblokir |

### Rules:
- **Jika ada `guardrails`:** patuhi, jangan ulangi kesalahan.
- **Jika ada `excluded_items`:** tidak boleh dipakai sebagai dasar jawaban.

---

## STEP 1 — RETRIEVAL SEBELUM MENJAWAB (Wajib untuk jawaban teknis)

### Kapan wajib:
- ✅ Sebelum menjawab teknis/konfigurasi/debugging/perintah CLI
- ✅ Sebelum membuat keputusan
- ✅ Sebelum menyimpulkan "sudah pernah dilakukan"

```javascript
memory_search({ project_id, query: "<intent + keyword>", limit: 10 })
```

### Rules pemilihan:
- Ambil item dengan `final_score` tertinggi
- Abaikan item yang masuk `excluded`
- Jika `embedding_mode=hybrid`, pastikan `score_breakdown.vector > 0` untuk klaim semantic
- Jika hasil kosong atau tidak relevan → lanjut ke Step 2 (writeback)

---

## STEP 2 — WRITEBACK GATING (Simpan hanya yang "bernilai jangka panjang")

### ⚠️ Jangan simpan semua hal. Simpan hanya jika memenuhi minimal 1 kondisi ini:

| # | Kondisi | Action |
|---|---------|--------|
| 1 | Mengubah progres proyek / state / TODO | → 2A |
| 2 | Keputusan penting (decision) | → 2C |
| 3 | Evidence kerja nyata (command, file path, output, error) | → 2B |
| 4 | Preferensi user eksplisit | → 2D |
| 5 | Guardrail baru (kesalahan berulang) | → Step 5 |
| 6 | Koreksi memori salah (feedback wrong) | → Step 4 |

---

### 2A) Simpan / update STATE (progres & TODO)

```javascript
memory_upsert({
  items: [{
    type: "state",
    project_id,
    title: "State: <nama proyek>",
    content: "Tujuan: ...\nProgres: ...\nTODO: ...\nBlockers: ...",
    tags: ["state", "milestone"],
    verified: true,
    provenance_json: { model_id: "<model>", phase: "<phase>" }
  }]
})
```

---

### 2B) Simpan EVIDENCE (work log yang bisa diaudit)

```javascript
memory_upsert({
  items: [{
    type: "fact",
    project_id,
    title: "Evidence: <aksi>",
    content: "Aksi: ...\nCommand: ...\nPath: ...\nHasil: ...\nError: ...",
    tags: ["work_log", "evidence"],
    provenance_json: { model_id: "<model>" }
  }]
})
```

---

### 2C) Simpan DECISION (harus ada alasan + bukti)

```javascript
memory_upsert({
  items: [{
    type: "decision",
    project_id,
    title: "Decision: <judul>",
    content: "Keputusan: ...\nAlasan: ...\nBukti: <ID evidence / output>",
    tags: ["decision", "<topik>"],
    verified: true,
    provenance_json: { model_id: "<model>", rationale: "...", evidence_ids: ["..."] }
  }]
})
```

---

### 2D) Simpan PREFERENSI USER (agar user tidak mengulang)

```javascript
memory_upsert({
  items: [{
    type: "fact",
    project_id,
    title: "User Preference: <ringkas>",
    content: "[USER_PREF] <kutipan user>",
    tags: ["user_preference"],
    verified: true,
    provenance_json: { source: "user_explicit" }
  }]
})
```

---

## STEP 3 — JAWAB DENGAN "MEMORY-CITED" (Anti-ngasal)

### Rule wajib:
Setiap jawaban penting harus menyebutkan basis memori yang dipakai.

### Format internal (boleh tidak ditampilkan ke user, tapi harus ada di log):
```
Basis memori: state_latest=<id>, evidence=[id1,id2], decision=[id3]
```

### Jika AI tidak bisa menemukan basis memori:
→ harus `memory_upsert` dulu (evidence/state), baru jawab.

---

## STEP 4 — SELF-HEALING (Jika salah, jangan ditutupi)

### Jika ada memori salah/berbahaya/kontradiksi:

```javascript
memory_feedback({ id: "<memory_id>", label: "wrong", notes: "<alasan teknis>" })
```

### Lalu jalankan:

```javascript
memory_maintain({ project_id, actions: ["prune"], mode: "apply" })
```

### Rules:
- Item `wrong` harus masuk `quarantined` dan keluar dari hasil search standar.
- Jika `error_count >= threshold` → wajib `deleted` sesuai policy.

---

## STEP 5 — LOOP BREAKER (Jika kesalahan berulang)

### Jika kesalahan sama terulang ≥2x:

```javascript
memory_maintain({ project_id, actions: ["loopbreak"], mode: "apply" })
```

### Rules:
- `guardrails` harus muncul di summarize.
- AI wajib patuh guardrails pada jawaban berikutnya.

---

## STEP 6 — PENUTUP TASK (Snapshot final)

```javascript
memory_upsert({
  items: [{
    type: "decision",
    project_id,
    title: "FINAL: <task> - <hasil>",
    content: "Ringkasan: ...\nArtefak: ...\nHasil: ...\nNext: ...",
    tags: ["final", "decision"],
    verified: true
  }]
})
```

---

## STEP 7 — MAINTENANCE BERKALA (Skala besar)

### Preview dulu:

```javascript
memory_maintain({ project_id, actions: ["dedup", "prune", "compact"], mode: "dry_run" })
```

### Jika aman:

```javascript
memory_maintain({ project_id, actions: ["dedup", "prune", "compact"], mode: "apply" })
```

### Rules:
- `state` & `decision` jangan auto-delete.
- Prune fokus ke `runbook`/`fact` yang salah/duplikat/noisy.

---

## CHECKLIST WAJIB PER SESI (yang harus dipatuhi AI)

```
□ Jalankan memory_summarize di awal sesi
□ Jalankan memory_search sebelum jawaban teknis
□ Upsert hanya jika memenuhi writeback-gating
□ Gunakan governance: wrong → prune, berulang → loopbreak
□ Buat snapshot FINAL sebelum selesai
```

---

## HASIL BENCHMARK (Bukti Workflow Bekerja)

| Metrik | Keyword-Only | Hybrid V3.2 | Improvement |
|--------|--------------|-------------|-------------|
| Recall@5 | 20% | 64% | **+220%** |
| Self-Healing | ❌ | ✅ | Active |
| Cross-Model | ❌ | ✅ | 2 models |
| Guardrails | ❌ | ✅ | Auto |
| Ultimate Test | - | 12/12 PASS | - |

---

**Workflow ini sudah TERBUKTI dengan benchmark +220% dan 12/12 test PASS.**
