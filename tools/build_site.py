"""Build the static GitHub Pages data for the level C dry-run cases.

Reads results/<case>/alignment_viewer.html (Plotly traces written by the
evaluation pipeline) and deviation.json, and writes docs/data/<case>.bin plus
docs/data/cases.json. The plan->achieved rigid transform of the head is
recovered exactly from the displacement-vector trace (Kabsch).

usage:  python tools/build_site.py
"""
import base64
import json
from pathlib import Path

import fast_simplification
import numpy as np
import trimesh

ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "results"
OUT = ROOT / "docs" / "data"
# planning STLs live in the evaluation project; they share the scene frame of results/*/aligned_stl
PLANNINGS = ROOT.parent / "osteotomy_specimen_evaluation" / "data" / "EMT_ex_vivo_plannings"

CASES = [
    {"id": "260266", "folder": "260266_EMT_C_2D", "method": "EMT", "side": "Left",
     "sensitivity_folder": "260266_EMT_C_2D/automatic_shaft_fit"},
    {"id": "260519_L", "folder": "260519_L_PSI_C", "method": "PSI", "side": "Left",
     "sensitivity_folder": "260519_L_PSI_C"},
]

# mesh key -> (source, glob inside that source, target triangle count or None to keep all)
MESHES = {
    "plan_shaft": ("planning", "Femur_?_?_Prox.stl", None),
    "plan_head": ("planning", "Femur_?_?_Dist_PostOp.stl", None),
    "preop_head": ("planning", "Femur_?_?_Dist_PreOp.stl", 24000),
    "wedge": ("planning", "Femur_?_?_Offcut.stl", None),
    "scan_head": ("aligned", "scan_head.stl", 70000),
    "scan_shaft": ("aligned", "scan_shaft.stl", 30000),
}


def plotly_traces(path):
    s = path.read_text(encoding="utf-8")
    i = s.rfind("Plotly.newPlot(")
    data, _ = json.JSONDecoder().raw_decode(s[s.find("[", i):])
    return {t.get("name"): t for t in data}


def arr(v):
    if isinstance(v, dict):
        return np.frombuffer(base64.b64decode(v["bdata"]), dtype=np.dtype(v["dtype"]))
    return np.array([np.nan if x is None else x for x in v], dtype=float)


def xyz(trace):
    return np.stack([arr(trace[k]).astype(float) for k in "xyz"], 1)


def load_mesh(path, target):
    """Load an STL (merged vertices) and optionally decimate it to about `target` triangles."""
    m = trimesh.load(path, force="mesh")
    v, f = np.asarray(m.vertices, float), np.asarray(m.faces, np.int64)
    if target and len(f) > target:
        v, f = fast_simplification.simplify(v.astype(np.float32), f, target_reduction=1 - target / len(f))
    return np.asarray(v, float), np.asarray(f, np.int64)


def kabsch(a, b):
    ca, cb = a.mean(0), b.mean(0)
    u, _, vt = np.linalg.svd((a - ca).T @ (b - cb))
    d = np.diag([1, 1, np.sign(np.linalg.det(vt.T @ u.T))])
    r = vt.T @ d @ u.T
    return r, cb - r @ ca


def unit(v):
    return v / np.linalg.norm(v)


def build(case):
    folder = RESULTS / case["folder"]
    tr = plotly_traces(folder / "alignment_viewer.html")
    dev = json.loads((folder / "deviation.json").read_text())
    sens_json = json.loads((RESULTS / case["sensitivity_folder"] / "deviation.json").read_text())
    sens = sens_json.get("sensitivity")
    slide = sens_json.get("axial_slide", {}).get("windows", {}).get("2")
    sens_auto_total = sens_json["deviation_total_deg"]

    # exact plan -> achieved head transform from the (4x exaggerated) displacement vectors
    seg = xyz(tr["displacement vectors (4x)"]).reshape(-1, 3, 3)
    a = seg[:, 0]
    b = a + (seg[:, 1] - a) / 4.0
    r, t = kabsch(a, b)
    angle = np.degrees(np.arccos(np.clip((np.trace(r) - 1) / 2, -1, 1)))
    assert abs(angle - dev["deviation_total_deg"]) < 1e-3, (angle, dev["deviation_total_deg"])

    sources = {"planning": PLANNINGS / dev["planning"], "aligned": folder / "aligned_stl"}
    meshes = {}
    for k, (src, pattern, target) in MESHES.items():
        (path,) = sources[src].glob(pattern)
        meshes[k] = load_mesh(path, target)
    origin = meshes["plan_head"][0].mean(0)

    # anatomical frame: shaft axis points proximally, condylar axis orthogonalised
    sa = xyz(tr["shaft axis"]) - origin
    ca = xyz(tr["condylar axis"]) - origin
    up = unit(sa[1] - sa[0])
    if up[2] < 0:
        up = -up
    cond = unit(ca[1] - ca[0])
    cond = unit(cond - up * (cond @ up))
    ap = np.cross(up, cond)

    blob = bytearray()
    index = {}
    for k, (v, f) in meshes.items():
        pos = (v - origin).astype("<f4").tobytes()
        idx = f.astype("<u4").tobytes()
        index[k] = {"posOffset": len(blob), "vertices": len(v)}
        blob += pos
        index[k]["idxOffset"] = len(blob)
        index[k]["triangles"] = len(f)
        blob += idx

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"{case['id']}.bin").write_bytes(bytes(blob))

    def pt(name):
        return (xyz(tr[name])[0] - origin).round(3).tolist()

    t_centered = r @ origin + t - origin
    return {
        "id": case["id"],
        "method": case["method"],
        "side": case["side"],
        "planning": dev["planning"],
        "bin": f"data/{case['id']}.bin",
        "meshes": index,
        "transform": {"R": r.round(9).tolist(), "t": t_centered.round(6).tolist()},
        "frame": {"up": up.round(6).tolist(), "condylar": cond.round(6).tolist(), "ap": ap.round(6).tolist()},
        "points": {
            "knee_planned": pt("knee centre (planned)"),
            "knee_achieved": pt("knee centre (achieved)"),
            "shaft_axis": (sa).round(3).tolist(),
            "condylar_axis": (ca).round(3).tolist(),
        },
        "metrics": {
            "planned_total_deg": dev["planned_correction_total_deg"],
            "achieved_total_deg": dev["achieved_correction_total_deg"],
            "planned": dev["planned_correction"],
            "achieved": dev["achieved_correction"],
            "deviation_total_deg": dev["deviation_total_deg"],
            "deviation": dev["deviation_components"],
            "translation": dev["translation"],
            "head_displacement_mm": dev["head_surface_displacement_mm"],
            "head_fit": dev["head_fit"],
            "shaft_fit": dev["shaft_fit"],
            "shaft_pose": dev.get("shaft_pose", "automatic"),
            "sensitivity": sens,
            "sensitivity_run_total_deg": sens_auto_total,
            "axial_slide_2mm": slide,
        },
    }


def main():
    cases = [build(c) for c in CASES]
    (OUT / "cases.json").write_text(json.dumps(cases, indent=1))
    for c in cases:
        size = (OUT / f"{c['id']}.bin").stat().st_size / 1e6
        print(f"{c['id']}: {c['metrics']['deviation_total_deg']:.2f} deg, {size:.1f} MB")


if __name__ == "__main__":
    main()
