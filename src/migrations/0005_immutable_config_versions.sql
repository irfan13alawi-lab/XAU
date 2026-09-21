CREATE TRIGGER config_versions_no_update
BEFORE UPDATE ON config_versions
BEGIN
  SELECT RAISE(ABORT, 'config_versions is append-only');
END;

CREATE TRIGGER config_versions_no_delete
BEFORE DELETE ON config_versions
BEGIN
  SELECT RAISE(ABORT, 'config_versions is append-only');
END;
