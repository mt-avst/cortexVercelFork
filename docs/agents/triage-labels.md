# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## Priority labels

Orthogonal to the five roles above, every open issue also carries one scoped priority label:

| Label | Meaning |
| ------------- | ------------------------------------------------------------------- |
| `priority::1` | Production correctness, security or data loss - fix before feature work |
| `priority::2` | Reliability under load or important debt - schedule deliberately |
| `priority::3` | Tooling, harness and polish - fine to defer |

Scoped labels are mutually exclusive - setting one replaces another. When triaging, assign
both a role label and a priority.
