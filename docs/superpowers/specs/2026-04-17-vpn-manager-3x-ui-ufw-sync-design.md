# VPN Manager — automatic UFW sync after 3x-ui inbound changes — design

**Date:** 2026-04-17  
**Status:** Approved for implementation planning  
**Depends on:** VPN profiles with **SSH access** to the same host that runs 3x-ui (existing `host`, `ssh_port`, `ssh_user`, encrypted SSH secret model). 3x-ui HTTP API flows that create, update, or delete inbounds. Optional alignment with future work that mutates inbounds from multiple routes.

## Summary

Operators may run **strict `ufw`** on the 3x-ui host. Today, **VPN Manager does not** open Xray inbound ports when it provisions inbounds via the panel API (see e.g. chain client access v1 non-goals). This feature adds a **post-mutation step**: after a **successful** 3x-ui inbound change initiated by VPN Manager, the server **SSHes** to the profile host and runs a **small, versioned reconcile script** that updates **only UFW rules it owns** (tagged comment), derived from **`/etc/x-ui/x-ui.db`** so ports stay aligned with the panel. If **`ufw` is absent or inactive**, the step **succeeds without error**. If **`ufw` is active** and reconcile fails after **retries**, the API **fails** and performs **best-effort compensation** (e.g. delete an inbound that was just created).

## Goals (v1)

1. **Trigger scope:** After **successful** 3x-ui HTTP mutations that can change listeners (minimum: **`inbounds/add`**, **`inbounds/update`**, **`inbounds/del`** or upstream equivalents used by the codebase), invoke firewall sync for that **VPN profile** when **SSH is configured and the SSH feature gate allows execution**.  
2. **Execution model (B):** Sync runs **over SSH** on the **same host** as the profile’s `host`, using existing **`SshExecFn`-style** execution and encrypted credentials.  
3. **Mechanism:** Prefer a **fixed remote command** (e.g. `sudo /usr/local/sbin/vpnmgr-xui-ufw-sync`) with **no client-controlled shell interpolation**. The script reads **`/etc/x-ui/x-ui.db`** (3x-ui source of truth), derives **panel `webPort`** and **enabled inbound ports** (and **TCP vs UDP** per row, e.g. `wireguard` → UDP; default TCP), and **reconciles** UFW: delete only rules with a dedicated comment (e.g. `vpnmgr-xui`), then add current set.  
4. **No UFW / inactive UFW:** If **`ufw` is not installed** (binary missing) **or** `ufw status` shows **`Status: inactive`**, the script **exits 0**, logs a single **skip** line, and VPN Manager treats the step as **success** — **no error**, **no compensation**.  
5. **Active UFW — retries:** On non-zero exit or transient SSH failure, **retry** the SSH step a **bounded N** times (e.g. 3–5) with **small backoff** (e.g. 200ms–1s). Retries apply to **SSH/sync only**, not to panel HTTP mutations.  
6. **Active UFW — failure (A):** If retries are exhausted, the **overall request fails**; for flows that **created** an inbound in this request, perform **best-effort** **compensating delete** on 3x-ui so the panel does not leave a listener that the operator believes was “fully provisioned.” If compensation fails, **log loudly**; the primary error remains **firewall sync failure**.  
7. **Strict coexistence:** Never delete or alter **manual** UFW rules; only rules carrying the **agreed comment prefix** are managed by the script.

## Non-goals (v1)

- Syncing **cloud security groups** (AWS, Hetzner, etc.).  
- Supporting **firewalld / nftables** reconciliation when UFW is not the active tool (hosts without UFW or with inactive UFW are **skip**; other stacks remain operator-owned).  
- **Polling** the panel on a timer from VPN Manager without an inbound mutation (optional future “repair” button).  
- **Inbound changes made only in the 3x-ui UI** while VPN Manager is idle — those will **not** update UFW until the **next** Manager-triggered mutation **or** a future out-of-scope “sync firewall” action.  
- Changing the chain client access **HTTP-only** principle for **panel** traffic; firewall sync is **orthogonal SSH** traffic.

## Relationship to existing specs

- **Chain client access (v1)** explicitly deferred UFW on the remote host. This design **adds** an optional strictness path when **SSH** is available; routes that mutate inbounds should **either** call the new sync hook **or** document why they cannot (e.g. no SSH). If both apply to one flow, **order** must be: **panel success → UFW sync → return success** (or fail per §Goals).

## Architecture

| Component | Responsibility |
|-----------|------------------|
| **`apps/server`** (call sites) | After successful 3x-ui inbound add/update/delete, call **`syncXuiUfw(profileContext)`** (name TBD) when SSH is usable. |
| **`apps/server`** (sync module) | Resolve SSH target from profile; run **fixed** remote command; interpret exit codes (**0 skip**, **0 ok**, **non-zero fail**); implement **retry** policy; on final failure invoke **compensation** helper and surface **4xx/5xx** with safe message. |
| **Remote script** (`vpnmgr-xui-ufw-sync`) | Detect no/inactive UFW → **exit 0**. If active: read SQLite (`settings.webPort`, `inbounds` enabled rows), reconcile **tagged** `ufw` rules only. Must be **idempotent**. |
| **Operator / install path** | Ensure script is installed and `sudo` allows it (e.g. **sudoers** drop-in or path owned by root). Exact delivery mechanism (bundled in repo vs doc-only for v1) is an **implementation plan** detail. |

**Rationale for reconcile-from-SQLite:** Single source of truth with the panel; avoids duplicating port/protocol inference in TypeScript and handles **update** paths cleanly.

## Data flow

1. VPN Manager completes **3x-ui HTTP** mutation successfully.  
2. If profile **lacks SSH** or gate **disallows** SSH: **skip** sync (document whether skip is silent or logged; default **silent skip** to avoid breaking profiles without SSH).  
3. Else: SSH run **reconcile script** (with retries on failure).  
4. If **skip** (no UFW / inactive): treat as success; return normal success payload.  
5. If **active UFW** and success: return normal success.  
6. If **active UFW** and final failure: run **compensation** for **create** flows; return **error** to client.

## Error handling and ordering

- **Panel first:** Do not modify UFW if the panel call did not succeed.  
- **Create flow:** Record **inbound identity** needed for compensating delete **before** relying on sync success.  
- **Update/delete flows:** Compensation policy: **delete** only applies to **“we just created this inbound in the same request”**; for update/delete failures, **fail the request** without inventing new rollback beyond what the plan specifies (e.g. **no automatic restore** of previous UFW state in v1).  
- **Logging:** Never log full panel secrets or SSH passwords; log **profile id**, **host**, **exit code**, and **retry count**.

## Testing

- **Unit:** Mock **`SshExecFn`**; assert **command string** is exactly the expected **sudo** path (no injection).  
- **Unit:** Map exit codes → success / retry / fail / skip semantics.  
- **Integration (optional):** Fixture SQLite + fake `ufw` in a container is high effort; prefer **script unit tests** in shell or a tiny test harness if added in the plan.

## Open questions (for implementation plan)

1. **Install path:** Ship script in-repo and document **one-time** `scp` + `chmod`, vs integrate into **setup-terminal** / install flow.  
2. **Sudo:** `NOPASSWD` for **only** that script vs full `ufw` — prefer **script-only** sudoers.  
3. **Which routes** in v1 call sync (only chain generate-profile, or every inbound mutation site)?  
4. **Exact N and backoff** constants and whether **certain SSH exit codes** are non-retryable.

## Spec self-review

- **Placeholders:** None intentional; open questions are explicitly listed.  
- **Consistency:** Failure policy **A** applies only when **UFW is active**; **no error** when **missing or inactive**, per approval.  
- **Scope:** Single feature; does not expand to cloud SGs or non-UFW firewalls.  
- **Ambiguity:** “Inactive” is **`ufw status` → inactive**; “not installed” is **missing binary** — both **skip**.
