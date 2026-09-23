-- Keep the newest 200 operations per project (OPS_RETENTION_PER_PROJECT in schema.ts).
CREATE TRIGGER `ops_retention` AFTER INSERT ON `ops`
BEGIN
	DELETE FROM `ops`
	WHERE `project` = NEW.`project`
		AND `rowid` NOT IN (
			SELECT `rowid` FROM `ops`
			WHERE `project` = NEW.`project`
			ORDER BY `started_at` DESC, `rowid` DESC
			LIMIT 200
		);
END;
