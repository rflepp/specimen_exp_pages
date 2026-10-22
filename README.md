# Level C dry run: planned vs achieved osteotomy

Interactive presentation of the surgical-navigation dry run (level C) for specimens
**260266 (EMT)** and **260519 L (PSI)**: 3D overlays of plan vs post-op scan, displacement
error maps, an animated plan → result morph, and the per-axis error breakdown.

The site is static and lives in [`docs/`](docs/) (served by GitHub Pages from `main` / `docs`).

## Rebuilding the data

```
pip install numpy trimesh fast-simplification
python tools/build_site.py
```

`build_site.py` reads `results/<case>/` (evaluation pipeline output: `deviation.json`,
`alignment_viewer.html`, `aligned_stl/`) and the planning STLs from
`../osteotomy_specimen_evaluation/data/EMT_ex_vivo_plannings/`, and writes `docs/data/`.
The plan → achieved head transform is recovered exactly from the pipeline's displacement
vectors and checked against the reported total deviation.

Preview locally with `python -m http.server -d docs`.
