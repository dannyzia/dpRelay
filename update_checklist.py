import re

with open("docs/Modification 2/dev-checklist.yaml", "r") as f:
    lines = f.read().splitlines()

completed_ids = {"INFRA-01", "INFRA-02", "INFRA-03", "ENV-01", "RTDB-01", "AD-01", "AD-02", "ROUTE-01", "ROUTE-02", "MK-01", "MK-02", "MK-03"}
pending_ids = {"AD-04", "AD-05", "AD-06", "AD-07", "AD-08", "CP-01", "CP-02", "CP-03", "PG-01", "RM-01", "RM-02", "RM-03", "RM-04"}

out_lines = []
for line in lines:
    modified_line = line.replace("admin-dashboard/", "web/")
    
    id_match = re.match(r'^(\s+)- id:\s+([A-Z0-9-]+)', modified_line)
    if id_match:
        indent = id_match.group(1)
        current_id = id_match.group(2)
        out_lines.append(modified_line)
        if current_id in completed_ids:
            out_lines.append(f'{indent}  status: "complete"')
            out_lines.append(f'{indent}  note: "Frontend implemented – see web/ directory"')
        elif current_id in pending_ids:
            out_lines.append(f'{indent}  status: "pending"')
            out_lines.append(f'{indent}  note: "Frontend UI not yet implemented – pending Phase 10"')
        continue
    
    # Replace the total_phases count and critical_path
    if modified_line.startswith("total_phases:"):
        modified_line = modified_line.replace("9", "10")
    if modified_line.startswith("critical_path:") and "[1," in modified_line:
        modified_line = "critical_path: [1, 2, 3, 5, 6, 7, 8, 9, 10]"
        
    out_lines.append(modified_line)

phase_10_yaml = """  - id: 10
    name: "Frontend Completion & Integration"
    blocking: false
    description: >
      Build out the remaining frontend dashboard, admin, and authentication pages. 
      Integrate these components with the established Firebase backend (Auth, Firestore, Functions).
    items:
      - id: FE-01
        task: "Build Authentication Pages"
        files_to_create:
          - "web/src/pages/auth/Login.jsx"
          - "web/src/pages/auth/Register.jsx"
        ui_requirements:
          - "Login and Registration functionality using Firebase Auth."
        depends_on: [AD-02]
        priority: high

      - id: FE-02
        task: "Build Client Dashboard Pages"
        files_to_create:
          - "web/src/pages/dashboard/DashboardHome.jsx"
          - "web/src/pages/dashboard/Apps.jsx"
          - "web/src/pages/dashboard/BuyCredits.jsx"
          - "web/src/pages/dashboard/Transactions.jsx"
          - "web/src/pages/dashboard/Playground.jsx"
          - "web/src/pages/dashboard/Settings.jsx"
        ui_requirements:
          - "Full client portal for managing apps, purchasing credits, and testing OTPs."
        depends_on: [FE-01, CF-01, BK-02]
        priority: high

      - id: FE-03
        task: "Build Admin Dashboard Pages"
        files_to_create:
          - "web/src/pages/admin/AdminHome.jsx"
          - "web/src/pages/admin/Packages.jsx"
          - "web/src/pages/admin/ApproveTransactions.jsx"
          - "web/src/pages/admin/Metrics.jsx"
        ui_requirements:
          - "Admin interface for creating packages, approving bKash transactions, and viewing platform metrics."
        depends_on: [FE-01, BK-00, CF-04]
        priority: high

      - id: FE-04
        task: "Update Firebase Hosting Target & Deploy"
        files_to_modify:
          - "firebase.json"
        task_details:
          - "Ensure firebase.json points to web/dist for hosting."
          - "Deploy the complete web application."
        depends_on: [FE-02, FE-03]
        priority: high

      - id: FE-05
        task: "Write Final Documentation"
        files_to_create:
          - "README.md"
          - "docs/FIREBASE_SETUP.md"
        task_details:
          - "Document local development setup, emulator usage, and deployment steps."
        depends_on: [FE-04]
        priority: medium
"""

idx = 0
for i, line in enumerate(out_lines):
    if line.startswith("validation_commands:"):
        idx = i
        break

if idx > 0:
    out_lines.insert(idx, phase_10_yaml)

with open("docs/Modification 2/dev-checklist.yaml", "w") as f:
    f.write('\n'.join(out_lines))
