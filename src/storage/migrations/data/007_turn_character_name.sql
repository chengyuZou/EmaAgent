-- Turn stores the stable Character.name, not the editable displayName.
ALTER TABLE turns RENAME COLUMN character_directory_name TO character_name;
