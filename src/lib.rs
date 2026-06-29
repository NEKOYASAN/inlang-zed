use std::{env, path::PathBuf};

use zed_extension_api::{
    self as zed, serde_json::Value, settings::LspSettings, Command, LanguageServerId, Result,
    Worktree,
};

const PACKAGE_NAME: &str = "inlang-language-server";
const SERVER_PATH: &str = "bin/server.mjs";

struct InlangExtension {
    installed: bool,
}

impl InlangExtension {
    fn server_path() -> Result<PathBuf> {
        Ok(env::current_dir()
            .map_err(|error| format!("failed to resolve Inlang extension directory: {error}"))?
            .join("node_modules")
            .join(PACKAGE_NAME)
            .join(SERVER_PATH))
    }

    fn install_server_if_needed(&mut self, language_server_id: &LanguageServerId) -> Result<()> {
        let installed_version = zed::npm_package_installed_version(PACKAGE_NAME)?;

        if self.installed && installed_version.is_some() {
            return Ok(());
        }

        zed::set_language_server_installation_status(
            language_server_id,
            &zed::LanguageServerInstallationStatus::CheckingForUpdate,
        );

        let latest_version = match zed::npm_package_latest_version(PACKAGE_NAME) {
            Ok(version) => version,
            Err(error) if installed_version.is_some() => {
                self.installed = true;
                println!(
                    "failed to check latest {PACKAGE_NAME} version, reusing installed package: {error}"
                );
                return Ok(());
            }
            Err(error) => return Err(error),
        };

        if installed_version.as_ref() != Some(&latest_version) {
            zed::set_language_server_installation_status(
                language_server_id,
                &zed::LanguageServerInstallationStatus::Downloading,
            );

            if let Err(error) = zed::npm_install_package(PACKAGE_NAME, &latest_version) {
                if installed_version.is_none() {
                    return Err(format!("failed to install {PACKAGE_NAME}: {error}"));
                }

                println!(
                    "failed to update {PACKAGE_NAME} to {latest_version}, reusing installed package: {error}"
                );
            }
        }

        let server_path = Self::server_path()?;
        if !server_path.is_file() {
            return Err(format!(
                "installed package '{PACKAGE_NAME}' did not contain expected server entry '{}'",
                server_path.display()
            ));
        }

        self.installed = true;
        Ok(())
    }
}

impl zed::Extension for InlangExtension {
    fn new() -> Self {
        Self { installed: false }
    }

    fn language_server_command(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<Command> {
        let settings = LspSettings::for_worktree(language_server_id.as_ref(), worktree)?;

        if let Some(binary) = settings.binary {
            if let Some(path) = binary.path {
                return Ok(Command {
                    command: path,
                    args: binary.arguments.unwrap_or_default(),
                    env: Default::default(),
                });
            }

            if let Some(arguments) = binary.arguments {
                return Ok(Command {
                    command: zed::node_binary_path()?,
                    args: arguments,
                    env: Default::default(),
                });
            }
        }

        self.install_server_if_needed(language_server_id)?;

        Ok(Command {
            command: zed::node_binary_path()?,
            args: vec![Self::server_path()?.to_string_lossy().to_string()],
            env: Default::default(),
        })
    }

    fn language_server_initialization_options(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<Option<zed_extension_api::serde_json::Value>> {
        Ok(Some(merged_lsp_settings(language_server_id, worktree)))
    }

    fn language_server_workspace_configuration(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<Option<zed_extension_api::serde_json::Value>> {
        Ok(Some(merged_lsp_settings(language_server_id, worktree)))
    }
}

fn merged_lsp_settings(language_server_id: &LanguageServerId, worktree: &Worktree) -> Value {
    let lsp_settings = LspSettings::for_worktree(language_server_id.as_ref(), worktree).ok();
    let mut settings = lsp_settings
        .as_ref()
        .and_then(|settings| settings.initialization_options.clone())
        .unwrap_or_default();

    if let Some(workspace_settings) = lsp_settings.and_then(|settings| settings.settings) {
        merge_json_value_into(workspace_settings, &mut settings);
    }

    settings
}

fn merge_json_value_into(source: Value, target: &mut Value) {
    match (source, target) {
        (Value::Object(source), Value::Object(target)) => {
            for (key, source_value) in source {
                match target.get_mut(&key) {
                    Some(target_value) => merge_json_value_into(source_value, target_value),
                    None => {
                        target.insert(key, source_value);
                    }
                }
            }
        }
        (source, target) => {
            *target = source;
        }
    }
}

zed::register_extension!(InlangExtension);
