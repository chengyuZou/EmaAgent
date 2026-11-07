use super::*;

#[test]
fn model_catalog_is_installed_once_independently_of_profile_database() {
    let root = std::env::temp_dir().join(format!(
        "ema-catalog-{}-{}",
        std::process::id(),
        rand::random::<u64>()
    ));
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("profile.db"), b"existing database").unwrap();
    let source = root.join("bundled.json");
    let destination = root.join("profile").join("models-dev.json");
    fs::write(&source, b"bundled catalog").unwrap();
    install_models_catalog(&source, &destination).unwrap();
    assert_eq!(fs::read(&destination).unwrap(), b"bundled catalog");
    fs::write(&destination, b"user refreshed catalog").unwrap();
    install_models_catalog(&source, &destination).unwrap();
    assert_eq!(fs::read(&destination).unwrap(), b"user refreshed catalog");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn copies_character_resources_into_unicode_directory() {
    let root = std::env::temp_dir().join(format!(
        "ema-character-test-{}-{}",
        std::process::id(),
        rand::random::<u64>()
    ));
    let source = root.join("source");
    let model = source.join("樱羽艾玛").join("live2d").join("ema");
    fs::create_dir_all(&model).unwrap();
    fs::write(model.join("ema.model3.json"), b"model").unwrap();

    let destination = root.join("characters");
    install_builtin_characters(&source, &destination).unwrap();
    assert_eq!(
        fs::read(
            destination
                .join("樱羽艾玛")
                .join("live2d")
                .join("ema")
                .join("ema.model3.json")
        )
        .unwrap(),
        b"model"
    );
    fs::remove_dir_all(root).unwrap();
}
