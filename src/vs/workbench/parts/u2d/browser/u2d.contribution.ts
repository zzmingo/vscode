'use strict';

import { Registry } from 'vs/platform/registry/common/platform';
import { IEditorRegistry, Extensions as EditorExtensions, EditorInput, IFileEditorInput } from 'vs/workbench/common/editor';
import { EditorDescriptor } from 'vs/workbench/browser/parts/editor/baseEditor';
import { SyncDescriptor } from 'vs/platform/instantiation/common/descriptors';
import { U2DEntityFileInput } from 'vs/workbench/parts/u2d/common/u2dEntityFileInput';
import { U2DVisualEditor } from 'vs/workbench/parts/u2d/browser/u2dVisualEditor';

// Register file editors
Registry.as<IEditorRegistry>(EditorExtensions.Editors).registerEditor(
	new EditorDescriptor(
		U2DVisualEditor.ID, // explicit dependency because we don't want these editors lazy loaded
		'',
		'vs/workbench/parts/u2d/browser/u2dVisualEditor',
		'U2DVisualEditor'
	),
	[
		new SyncDescriptor<EditorInput>(U2DEntityFileInput)
	]
);

// Register my file input factory
function registerFileInputFactory() {
	const fileInputFactory = Registry.as<IEditorRegistry>(EditorExtensions.Editors).getFileInputFactory();
	Registry.as<IEditorRegistry>(EditorExtensions.Editors).registerFileInputFactory({
		createFileInput: (resource, encoding, instantiationService): IFileEditorInput => {
			if (U2DEntityFileInput.isEntityFile(resource)) {
				return instantiationService.createInstance(U2DEntityFileInput, resource, encoding);
			} else {
				return fileInputFactory.createFileInput(resource, encoding, instantiationService);
			}
		}
	});
}

function tryRegister(): boolean {
	const fileInputFactory = Registry.as<IEditorRegistry>(EditorExtensions.Editors).getFileInputFactory();
	if (fileInputFactory) {
		registerFileInputFactory();
		return true;
	}
	return false;
}

function checkImmediate() {
	setImmediate(() => {
		if (!tryRegister()) {
			checkImmediate();
		}
	});
}

if (!Registry.as<IEditorRegistry>(EditorExtensions.Editors).getFileInputFactory()) {
	checkImmediate();
} else {
	registerFileInputFactory();
}