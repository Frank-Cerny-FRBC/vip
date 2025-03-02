/**
 * @flow
 * @format
 */

/**
 * External dependencies
 */
import chalk from 'chalk';
import formatters from 'lando/lib/formatters';
import { prompt, Confirm, Select } from 'enquirer';
import debugLib from 'debug';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Internal dependencies
 */
import {
	DEV_ENVIRONMENT_FULL_COMMAND,
	DEV_ENVIRONMENT_SUBCOMMAND,
	DEV_ENVIRONMENT_DEFAULTS,
	DEV_ENVIRONMENT_PROMPT_INTRO,
	DEV_ENVIRONMENT_COMPONENTS,
	DEV_ENVIRONMENT_NOT_FOUND,
} from '../constants/dev-environment';
import { getVersionList } from './dev-environment-core';
import type { AppInfo, ComponentConfig, InstanceOptions, EnvironmentNameOptions, InstanceData } from './types';

const debug = debugLib( '@automattic/vip:bin:dev-environment' );

const DEFAULT_SLUG = 'vip-local';

export function handleCLIException( exception: Error ) {
	const errorPrefix = chalk.red( 'Error:' );
	if ( DEV_ENVIRONMENT_NOT_FOUND === exception.message ) {
		const createCommand = chalk.bold( DEV_ENVIRONMENT_FULL_COMMAND + ' create' );

		const message = `Environment doesn't exist.\n\n\nTo create a new environment run:\n\n${ createCommand }\n`;
		console.log( errorPrefix, message );
	} else {
		let message = exception.message;
		// if the message has already ERROR prefix we should drop it as we are adding our own cool red Error-prefix
		message = message.replace( 'ERROR: ', '' );

		console.log( errorPrefix, message );

		if ( ! process.env.DEBUG ) {
			console.log( `Please re-run the command with "${ chalk.bold( 'DEBUG=@automattic/vip:bin:dev-environment' ) }" prepended to it and provide the stack trace on the support ticket.` );
			console.log( chalk.bold( '\nExample:\n' ) );
			console.log( 'DEBUG=@automattic/vip:bin:dev-environment vip dev-env create\n' );
		}

		debug( exception );
	}
}

export function getEnvironmentName( options: EnvironmentNameOptions ): string {
	if ( options.slug ) {
		return options.slug;
	}

	if ( options.app ) {
		const envSuffix = options.env ? `-${ options.env }` : '';

		return options.app + envSuffix;
	}

	return DEFAULT_SLUG;
}

export function getEnvironmentStartCommand( options: EnvironmentNameOptions ): string {
	if ( options.slug ) {
		return `${ DEV_ENVIRONMENT_FULL_COMMAND } start --slug ${ options.slug }`;
	}

	if ( options.app ) {
		let application = `@${ options.app }`;
		if ( options.env ) {
			application += `.${ options.env }`;
		}

		return `vip ${ application } ${ DEV_ENVIRONMENT_SUBCOMMAND } start`;
	}

	return `${ DEV_ENVIRONMENT_FULL_COMMAND } start`;
}

export function printTable( data: Object ) {
	const formattedData = formatters.formatData( data, { format: 'table' }, { border: false } );

	console.log( formattedData );
}

export function processComponentOptionInput( passedParam: string, allowLocal: boolean ): ComponentConfig {
	// cast to string
	const param = passedParam + '';
	if ( allowLocal && param.includes( '/' ) ) {
		return {
			mode: 'local',
			dir: param,
		};
	}

	return {
		mode: 'image',
		tag: param,
	};
}

export function getOptionsFromAppInfo( appInfo: AppInfo ): InstanceOptions {
	return {
		title: appInfo.environment?.name || appInfo.name || '',
		multisite: !! appInfo?.environment?.isMultisite,
		mediaRedirectDomain: appInfo.environment?.primaryDomain,
	};
}

/**
 * Prompt for arguments
 * @param {InstanceOptions} preselectedOptions - options to be used without prompt
 * @param {InstanceOptions} defaultOptions - options to be used as default values for prompt
 * @returns {any} instance data
 */
export async function promptForArguments( preselectedOptions: InstanceOptions, defaultOptions: $Shape<InstanceOptions> ): Promise<InstanceData> {
	debug( 'Provided preselected', preselectedOptions, 'and default', defaultOptions );

	console.log( DEV_ENVIRONMENT_PROMPT_INTRO );

	let multisiteText = 'Multisite';
	let multisiteDefault = DEV_ENVIRONMENT_DEFAULTS.multisite;

	if ( defaultOptions.title ) {
		multisiteText += ` (${ defaultOptions.title } ${ defaultOptions.multisite ? 'IS' : 'is NOT' } multisite)`;
		multisiteDefault = defaultOptions.multisite;
	}

	const instanceData: InstanceData = {
		wpTitle: preselectedOptions.title || await promptForText( 'WordPress site title', defaultOptions.title || DEV_ENVIRONMENT_DEFAULTS.title ),
		multisite: 'multisite' in preselectedOptions ? preselectedOptions.multisite : await promptForBoolean( multisiteText, !! multisiteDefault ),
		elasticsearch: preselectedOptions.elasticsearch || defaultOptions.elasticsearch || DEV_ENVIRONMENT_DEFAULTS.elasticsearchVersion,
		mariadb: preselectedOptions.mariadb || defaultOptions.mariadb || DEV_ENVIRONMENT_DEFAULTS.mariadbVersion,
		mediaRedirectDomain: preselectedOptions.mediaRedirectDomain || '',
		wordpress: {
			mode: 'image',
		},
		muPlugins: {
			mode: 'image',
		},
		clientCode: {
			mode: 'image',
		},
		statsd: false,
		phpmyadmin: false,
		xdebug: false,
		siteSlug: '',
	};

	if ( ! instanceData.mediaRedirectDomain && defaultOptions.mediaRedirectDomain ) {
		const mediaRedirectPromptText = `Would you like to redirect to ${ defaultOptions.mediaRedirectDomain } for missing media files?`;
		const setMediaRedirectDomain = await promptForBoolean( mediaRedirectPromptText, true );
		if ( setMediaRedirectDomain ) {
			instanceData.mediaRedirectDomain = defaultOptions.mediaRedirectDomain ?? '';
		}
	}

	for ( const component of DEV_ENVIRONMENT_COMPONENTS ) {
		const option = ( preselectedOptions[ component ] ?? '' ).toString();
		const defaultValue = ( defaultOptions[ component ] ?? '' ).toString();

		const result = await processComponent( component, option, defaultValue );
		if ( null === result ) {
			throw new Error( 'processComponent() returned null' );
		}

		instanceData[ component ] = result;
	}

	for ( const service of [ 'statsd', 'phpmyadmin', 'xdebug' ] ) {
		if ( service in preselectedOptions ) {
			instanceData[ service ] = preselectedOptions[ service ];
		} else if ( service in defaultOptions ) {
			instanceData[ service ] = defaultOptions[ service ];
		}
	}

	debug( 'Instance data after prompts', instanceData );
	return instanceData;
}

async function processComponent( component: string, preselectedValue: string, defaultValue: string ) {
	debug( `processing a component '${ component }', with preselected/deafault - ${ preselectedValue }/${ defaultValue }` );
	let result = null;

	const allowLocal = component !== 'wordpress';
	const defaultObject = defaultValue ? processComponentOptionInput( defaultValue, allowLocal ) : null;
	if ( preselectedValue ) {
		result = processComponentOptionInput( preselectedValue, allowLocal );
	} else {
		result = await promptForComponent( component, allowLocal, defaultObject );
	}

	while ( 'local' === result?.mode ) {
		const resolvedPath = resolvePath( result.dir || '' );
		result.dir = resolvedPath;

		const isDirectory = resolvedPath && fs.existsSync( resolvedPath ) && fs.lstatSync( resolvedPath ).isDirectory();
		const isEmpty = isDirectory ? fs.readdirSync( resolvedPath ).length === 0 : true;

		if ( isDirectory && ! isEmpty ) {
			break;
		} else {
			const message = `Provided path "${ resolvedPath }" does not point to a valid or existing directory.`;
			console.log( chalk.yellow( 'Warning:' ), message );
			result = await promptForComponent( component, allowLocal, defaultObject );
		}
	}

	return result;
}

export function resolvePath( input: string ): string {
	// Resolve does not do ~ reliably
	const resolvedPath = input.replace( /^~/, os.homedir() );
	// And resolve to handle relative paths
	return path.resolve( resolvedPath );
}

export async function promptForText( message: string, initial: string ): Promise<string> {
	const nonEmptyValidator = value => {
		if ( ( value || '' ).trim() ) {
			return true;
		}
		return 'value needs to be provided';
	};

	const result = await prompt( {
		type: 'input',
		name: 'input',
		message,
		initial,
		validate: nonEmptyValidator,
	} );

	return ( result?.input || '' ).trim();
}

export async function promptForBoolean( message: string, initial: boolean ): Promise<boolean> {
	const confirm = new Confirm( {
		message,
		initial,
	} );

	return confirm.run();
}

const componentDisplayNames = {
	wordpress: 'WordPress',
	muPlugins: 'vip-go-mu-plugins',
	clientCode: 'site-code',
};

export async function promptForComponent( component: string, allowLocal: boolean, defaultObject: ComponentConfig | null ): Promise<ComponentConfig> {
	debug( `Prompting for ${ component } with default:`, defaultObject );
	const componentDisplayName = componentDisplayNames[ component ] || component;
	const modChoices = [];

	if ( allowLocal ) {
		modChoices.push( {
			message: `local folder - where you already have ${ componentDisplayName } code`,
			value: 'local',
		} );
	}
	modChoices.push( {
		message: 'image - that gets automatically fetched',
		value: 'image',
	} );

	let initialMode = 'image';
	if ( 'clientCode' === component ) {
		initialMode = 'local';
	}

	if ( defaultObject?.mode ) {
		initialMode = defaultObject.mode;
	}

	let modeResult = initialMode;
	const selectMode = modChoices.length > 1;
	if ( selectMode ) {
		const initialModeIndex = modChoices.findIndex( choice => choice.value === initialMode );
		const select = new Select( {
			message: `How would you like to source ${ componentDisplayName }`,
			choices: modChoices,
			initial: initialModeIndex,
		} );

		modeResult = await select.run();
	}

	const messagePrefix = selectMode ? '\t' : `${ componentDisplayName } - `;
	if ( 'local' === modeResult ) {
		const directoryPath = await promptForText( `${ messagePrefix }What is a path to your local ${ componentDisplayName }`, defaultObject?.dir || '' );
		return {
			mode: modeResult,
			dir: directoryPath,
		};
	}

	// image with selection
	if ( component === 'wordpress' ) {
		const message = `${ messagePrefix }Which version would you like`;
		const tagChoices = await getTagChoices();

		// Tag strings come back from the api with excess whitespace
		// This strips the whitespace for matching to the defaultObject.tag
		const formatted = tagChoices.map( elm => {
			return elm.trim();
		} );

		// First tag not: "Pre-Release"
		const firstNonPreRelease = formatted.find( img => {
			return ! img.match( /Pre\-Release/g );
		} );

		// Set initialTagIndex as the first non Pre-Release
		let initialTagIndex = formatted.indexOf( firstNonPreRelease );

		if ( defaultObject?.tag ) {
			const defaultTagIndex = formatted.indexOf( defaultObject.tag );
			if ( defaultTagIndex !== -1 ) {
				initialTagIndex = defaultTagIndex;
			}
		}
		const selectTag = new Select( {
			message,
			choices: formatted,
			initial: initialTagIndex,
		} );
		const option = await selectTag.run();

		// Validate the input
		// Some of the options are like: '5.7   →  5.7.5'
		// Extract first occurrence of something that looks like a tag
		const tagRgx = new RegExp( /(\d+\.\d+(?:\.\d+)?)/ );
		const match = tagRgx.exec( option );
		if ( ! Array.isArray( match ) || match.length < 2 ) {
			throw new Error( `Invalid WordPress selection: ${ option }` );
		}

		const tag = match[ 1 ];

		return {
			mode: modeResult,
			tag,
		};
	}

	// image
	return {
		mode: modeResult,
	};
}

export function addDevEnvConfigurationOptions( command ) {
	return command
		.option( 'wordpress', 'Use a specific WordPress version' )
		.option( [ 'u', 'mu-plugins' ], 'Use a specific mu-plugins changeset or local directory' )
		.option( 'client-code', 'Use the client code from a local directory or VIP skeleton' )
		.option( 'statsd', 'Enable statsd component. By default it is disabled', undefined, value => 'false' !== value?.toLowerCase?.() )
		.option( 'phpmyadmin', 'Enable PHPMyAdmin component. By default it is disabled', undefined, value => 'false' !== value?.toLowerCase?.() )
		.option( 'xdebug', 'Enable XDebug. By default it is disabled', undefined, value => 'false' !== value?.toLowerCase?.() )
		.option( 'elasticsearch', 'Explicitly choose Elasticsearch version to use' )
		.option( 'mariadb', 'Explicitly choose MariaDB version to use' )
		.option( [ 'r', 'media-redirect-domain' ], 'Domain to redirect for missing media files. This can be used to still have images without the need to import them locally.' );
}

/**
 * Provides the list of tag choices for selection
 */
export async function getTagChoices() {
	const tagChoices = [];
	let tagFormatted, prerelease, mapping;
	const versions = await getVersionList();
	if ( versions.length < 1 ) {
		return [ '5.9', '5.8', '5.7', '5.6', '5.5' ];
	}

	for ( const version of versions ) {
		tagFormatted = version.tag.padEnd( 8 - version.tag.length );
		prerelease = ( version.prerelease ) ? '(Pre-Release)' : '';

		if ( version.tag !== version.ref ) {
			mapping = `→ ${ prerelease } ${ version.ref }`;
		} else {
			mapping = '';
		}

		tagChoices.push( `${ tagFormatted } ${ mapping }` );
	}

	return tagChoices.sort().reverse();
}
