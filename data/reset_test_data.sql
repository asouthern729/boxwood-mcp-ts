-- ============================================================================
-- boxwood_ams360_test reset
-- ============================================================================
-- Wipes every row from every table in boxwood_ams360_test (schema/constraints
-- untouched) so seed_test_data.sql can be re-run from a clean slate. CASCADE
-- handles FK dependency order automatically. Run against boxwood_ams360_test
-- only:
--
--   psql -h localhost -U andrew -d boxwood_ams360_test -f data/reset_test_data.sql
--   psql -h localhost -U andrew -d boxwood_ams360_test -f data/seed_test_data.sql
-- ============================================================================

TRUNCATE TABLE afw_policypersonnelperiods, afw_profileanswer, afw_profilequestion, afw_refgroup, afw_relationshiptype, afw_transaction, afw_xdate, afw_submission, afw_policysubcustomer, afw_policytranpremium, afw_setup1099, afw_policychklstheader, afw_basicpolinfo, afw_businessunitaccess, afw_broker, afw_agencynotation, afw_address, afw_commissiontemplatepersonnel, afw_claim, afw_custcontact, afw_custcontactresp, afw_customerattribute, afw_customerattributetype, afw_customerrelationship, afw_company, afw_custaddpersonnel, afw_customer, afw_generalledgerdepartment, afw_invoice, afw_generalledgergroup, afw_image, afw_dependent, afw_fieldimportance, afw_employee, afw_generalledgerbranch, afw_phonenumber, afw_polcontact, afw_policyattributetype, afw_lobsetup, afw_paymentplan, afw_lineofbusiness, afw_agencyxreftype, afw_commissiontemplate, afw_coverage, afw_custlosshist, afw_custxref, afw_externalentity, afw_generalledgerdivision, afw_leadlist, afw_logicaltable, afw_policyattribute, afw_policychklstdetail, afw_policypersonnel, afw_policytransaction, afw_relationship, afw_submissiongroup RESTART IDENTITY CASCADE;
