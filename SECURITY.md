# Security policy

## Reporting a vulnerability

Report suspected vulnerabilities in Kubescape's reusable workflows confidentially
to [security@kubescape.io](mailto:security@kubescape.io). You may also submit a
[private vulnerability report via GitHub](https://github.com/kubescape/kubescape/security/advisories/new),
the reporting channel specified in the
[Kubescape security policy](https://github.com/kubescape/project-governance/blob/main/SECURITY.md).
Identify `kubescape/workflows` as the affected repository when using that channel.

Do not disclose suspected vulnerabilities in public issues, pull requests, or
discussions. Include the following information in your confidential report:

- The affected workflow or action, including its path and commit SHA, tag, or
  branch reference, and affected versions if known.
- A description of the vulnerability and its potential impact.
- Steps to reproduce the issue and a minimal example of the calling workflow,
  where applicable.
- Any known mitigations or suggested fixes.

Remove credentials, tokens, secrets, and sensitive data from examples and logs
before sharing them.

## Response and disclosure

This repository follows the central Kubescape security policy: maintainers will
respond within seven working days of a report. If the issue is confirmed as a
vulnerability, maintainers will open a Security Advisory and acknowledge the
reporter's contribution. The project follows a 90-day disclosure timeline.
Coordinate disclosure with the maintainers through the confidential reporting
channel.
