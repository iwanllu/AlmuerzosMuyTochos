-- Resetear la contraseña de un amigo: cambia 'ana' y 'NuevaClave123' y pulsa Run en el SQL Editor.
update auth.users set encrypted_password = extensions.crypt('NuevaClave123', extensions.gen_salt('bf')), updated_at = now() where email = 'ana@almuerzosmuytochos.app';
