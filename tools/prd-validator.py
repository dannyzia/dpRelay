#!/usr/bin/env python3
"""PRD drift detection tool. Compares implementation against PRD/specification."""
import sys
import re
import os

def extract_prd_requirements(prd_path):
    if not os.path.exists(prd_path):
        print(f"PRD file not found: {prd_path}", file=sys.stderr)
        sys.exit(1)
    with open(prd_path) as f:
        content = f.read()
    requirements = []
    for line in content.split('\n'):
        line = line.strip()
        if line.startswith('- **') or line.startswith('* **'):
            requirements.append(line.strip('- *'))
        elif line.startswith('- ') and len(line) > 20:
            requirements.append(line[2:])
    return requirements

def check_implementation(impl_path, requirements):
    if not os.path.exists(impl_path):
        print(f"Implementation path not found: {impl_path}", file=sys.stderr)
        return []
    findings = []
    impl_content = ""
    if os.path.isfile(impl_path):
        with open(impl_path) as f:
            impl_content = f.read()
    elif os.path.isdir(impl_path):
        for root, _, files in os.walk(impl_path):
            for fname in files:
                if fname.endswith(('.kt', '.js', '.jsx', '.ts', '.tsx', '.md')):
                    with open(os.path.join(root, fname)) as f:
                        impl_content += f.read() + "\n"
    for req in requirements:
        keywords = re.findall(r'\b[A-Za-z]{4,}\b', req)
        if not keywords:
            continue
        found = sum(1 for kw in keywords if kw.lower() in impl_content.lower())
        coverage = found / len(keywords) if keywords else 0
        if coverage < 0.3:
            findings.append(f"MISSING: '{req[:80]}'")
        elif coverage < 0.7:
            findings.append(f"PARTIAL: '{req[:80]}'")
    return findings

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: prd-validator.py <prd-file> <implementation-path>")
        sys.exit(1)
    reqs = extract_prd_requirements(sys.argv[1])
    findings = check_implementation(sys.argv[2], reqs)
    if findings:
        print(f"PRD Drift Report — {len(findings)} issues found:")
        for f in findings:
            print(f"  {f}")
    else:
        print("No PRD drift detected.")
