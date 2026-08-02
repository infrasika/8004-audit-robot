-- Migration number: 0003 	 remove business outcomes misclassified as HTTP failures
DELETE FROM oasf_audit_fails
WHERE instr(last_response_excerpt, '"code":"AGENT_CARD_NOT_FOUND"') > 0
   OR instr(last_response_excerpt, '"code": "AGENT_CARD_NOT_FOUND"') > 0;
