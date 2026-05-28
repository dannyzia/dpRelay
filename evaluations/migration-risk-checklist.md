# Migration Risk Checklist

**Purpose:** Evaluate migration safety — backward compatibility, rollback plan, data integrity, schema validation, and duration estimation.

## Backward Compatibility
- [ ] Existing verification request records readable after migration
- [ ] Existing health ping records readable after migration
- [ ] Existing registered app records readable after migration
- [ ] Old API endpoints continue to work unchanged
- [ ] Client library `PhoneAuthHelper.kt` remains compatible (no breaking interface changes)
- [ ] Authenticator app (already deployed on device) works post-migration
- [ ] Firebase RTDB security rules backward compatible

## Rollback Plan
- [ ] Rollback script exists and has been tested on staging
- [ ] Rollback restores ALL affected data paths (not just partial restore)
- [ ] Rollback duration estimated and acceptable
- [ ] Data loss in rollback scenario quantified
- [ ] Rollback does not cause cascading failures in dependent services

## Data Integrity
- [ ] Schema validation runs before and after migration
- [ ] Foreign-key-like relationships preserved (receipt -> verification_request linkage)
- [ ] No data truncation or silent field dropping
- [ ] Existing TTL/timeout values preserved
- [ ] E.164 phone number formats preserved
- [ ] Challenge token hashes consistent before/after
- [ ] No duplicate record creation

## Schema Validation
- [ ] RTDB paths conform to `snake_case` convention
- [ ] All required fields present in new schema
- [ ] Optional fields clearly marked with defaults
- [ ] Field types unchanged (strings stay strings, numbers stay numbers)
- [ ] Timestamp format consistent (ISO 8601 vs Unix ms)

## Duration & Performance
- [ ] Migration duration estimated from staging run
- [ ] Write operations stay within Firebase RTDB limits
- [ ] Read operations during migration do not degrade API response times
- [ ] Migration can be paused/resumed if needed

## Approval
- [ ] Migration plan reviewed by architect
- [ ] Rollback plan reviewed by operations lead
- [ ] Migration scheduled during low-traffic window (Bangladesh business hours considered)
- [ ] Monitoring dashboard reviewed before execution
