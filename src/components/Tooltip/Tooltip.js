/**
 * Copyright IBM Corp. 2016, 2018
 *
 * This source code is licensed under the Apache-2.0 license found in the
 * LICENSE file in the root directory of this source tree.
 */

import React, { Component } from 'react';
import PropTypes from 'prop-types';
import { isForwardRef } from 'react-is';
import debounce from 'lodash.debounce';
import Icon from '../Icon';
import classNames from 'classnames';
import warning from 'warning';
import { iconInfoGlyph } from 'carbon-icons';
import Information from '@carbon/icons-react/lib/information/16';
import { settings } from 'carbon-components';
import FloatingMenu, {
  DIRECTION_LEFT,
  DIRECTION_TOP,
  DIRECTION_RIGHT,
  DIRECTION_BOTTOM,
} from '../../internal/FloatingMenu';
import ClickListener from '../../internal/ClickListener';
import { breakingChangesX, componentsX } from '../../internal/FeatureFlags';

const { prefix } = settings;

const matchesFuncName =
  typeof Element !== 'undefined' &&
  ['matches', 'webkitMatchesSelector', 'msMatchesSelector'].filter(
    name => typeof Element.prototype[name] === 'function'
  )[0];

/**
 * @param {Node} elem A DOM node.
 * @param {string} selector A CSS selector
 * @returns {boolean} `true` if the given DOM element is a element node and matches the given selector.
 * @private
 */
const matches = (elem, selector) =>
  typeof elem[matchesFuncName] === 'function' &&
  elem[matchesFuncName](selector);

/**
 * @param {Element} elem An element.
 * @param {string} selector An query selector.
 * @returns {Element} The ancestor of the given element matching the given selector.
 * @private
 */
const closest = (elem, selector) => {
  const doc = elem.ownerDocument;
  for (
    let traverse = elem;
    traverse && traverse !== doc;
    traverse = traverse.parentNode
  ) {
    if (matches(traverse, selector)) {
      return traverse;
    }
  }
  return null;
};

/**
 * @param {Element} menuBody The menu body with the menu arrow.
 * @param {string} menuDirection Where the floating menu menu should be placed relative to the trigger button.
 * @returns {FloatingMenu~offset} The adjustment of the floating menu position, upon the position of the menu arrow.
 * @private
 */
const getMenuOffset = (menuBody, menuDirection) => {
  const arrowStyle = menuBody.ownerDocument.defaultView.getComputedStyle(
    menuBody,
    ':before'
  );
  const arrowPositionProp = {
    [DIRECTION_LEFT]: 'right',
    [DIRECTION_TOP]: 'bottom',
    [DIRECTION_RIGHT]: 'left',
    [DIRECTION_BOTTOM]: 'top',
  }[menuDirection];
  const menuPositionAdjustmentProp = {
    [DIRECTION_LEFT]: 'left',
    [DIRECTION_TOP]: 'top',
    [DIRECTION_RIGHT]: 'left',
    [DIRECTION_BOTTOM]: 'top',
  }[menuDirection];
  const values = [arrowPositionProp, 'border-bottom-width'].reduce(
    (o, name) => ({
      ...o,
      [name]: Number(
        (/^([\d-]+)px$/.exec(arrowStyle.getPropertyValue(name)) || [])[1]
      ),
    }),
    {}
  );
  values[arrowPositionProp] = values[arrowPositionProp] || -6; // IE, etc.
  if (Object.keys(values).every(name => !isNaN(values[name]))) {
    const {
      [arrowPositionProp]: arrowPosition,
      'border-bottom-width': borderBottomWidth,
    } = values;
    return {
      left: 0,
      top: 0,
      [menuPositionAdjustmentProp]:
        Math.sqrt(Math.pow(borderBottomWidth, 2) * 2) - arrowPosition,
    };
  }
};

let didWarnAboutDeprecation = false;

export default class Tooltip extends Component {
  state = {};

  static propTypes = {
    /**
     * The ID of the trigger button.
     */
    triggerId: PropTypes.string,

    /**
     * The ID of the tooltip content.
     */
    tooltipId: PropTypes.string,

    /**
     * Open/closed state.
     */
    open: PropTypes.bool,

    /**
     * Contents to put into the tooltip.
     */
    children: PropTypes.node,

    /**
     * The CSS class names of the tooltip.
     */
    className: PropTypes.string,

    /**
     * The CSS class names of the trigger UI.
     */
    triggerClassName: PropTypes.string,

    /**
     * Where to put the tooltip, relative to the trigger UI.
     */
    direction: PropTypes.oneOf(['bottom', 'top', 'left', 'right']),

    /**
     * The adjustment of the tooltip position.
     */
    menuOffset: PropTypes.oneOfType([
      PropTypes.shape({
        top: PropTypes.number,
        left: PropTypes.number,
      }),
      PropTypes.func,
    ]),

    /**
     * The content to put into the trigger UI, except the (default) tooltip icon.
     */
    triggerText: PropTypes.node,

    /**
     * The callback function to optionally render the icon element.
     * It should be a component with React.forwardRef().
     */
    renderIcon: function(props, propName, componentName) {
      if (props[propName] == undefined) {
        return;
      }
      const RefForwardingComponent = props[propName];
      if (!isForwardRef(<RefForwardingComponent />))
        return new Error(`Invalid value of prop '${propName}' supplied to '${componentName}',
                          it should be created/wrapped with React.forwardRef() to have a ref and access the proper
                          DOM node of the element to calculate its position in the viewport.`);
    },

    /**
     * `true` to show the default tooltip icon.
     */
    showIcon: PropTypes.bool,

    /**
     * The tooltip icon element or `<Icon>` metadata.
     */
    icon: PropTypes.shape({
      width: PropTypes.string,
      height: PropTypes.string,
      viewBox: PropTypes.string.isRequired,
      svgData: PropTypes.object.isRequired,
    }),

    /**
     * The name of the default tooltip icon.
     */
    iconName: PropTypes.string,

    /**
     * The description of the default tooltip icon, to be put in its SVG 'aria-label' and 'alt' .
     */
    iconDescription: PropTypes.string,

    /**
     * The title of the default tooltip icon, to be put in its SVG `<title>` element.
     */
    iconTitle: PropTypes.string,

    /**
     * `true` if opening tooltip should be triggered by clicking the trigger button.
     */
    clickToOpen: PropTypes.bool,

    /**
     * Optional prop to specify the tabIndex of the Tooltip
     */
    tabIndex: PropTypes.number,
  };

  static defaultProps = {
    open: false,
    direction: DIRECTION_BOTTOM,
    showIcon: true,
    iconDescription: 'tooltip',
    iconTitle: '',
    triggerText: 'Provide triggerText',
    menuOffset: getMenuOffset,
    clickToOpen: breakingChangesX,
  };

  /**
   * A flag to detect if `oncontextmenu` event is fired right before `mouseover`/`mouseout`/`focus`/`blur` events.
   * @type {boolean}
   */
  _hasContextMenu = false;

  /**
   * The element of the tooltip body.
   * @type {Element}
   * @private
   */
  _tooltipEl = null;

  componentDidMount() {
    if (!this._debouncedHandleHover) {
      this._debouncedHandleHover = debounce(this._handleHover, 200);
    }
    requestAnimationFrame(() => {
      this.getTriggerPosition();
    });
  }

  componentWillUnmount() {
    if (this._debouncedHandleHover) {
      this._debouncedHandleHover.cancel();
      this._debouncedHandleHover = null;
    }
  }

  static getDerivedStateFromProps({ open }, state) {
    /**
     * so that tooltip can be controlled programmatically through this `open` prop
     */
    const { prevOpen } = state;
    return prevOpen === open
      ? null
      : {
          open,
          prevOpen: open,
        };
  }

  getTriggerPosition = () => {
    if (this.triggerEl) {
      const triggerPosition = this.triggerEl.getBoundingClientRect();
      this.setState({ triggerPosition });
    }
  };

  /**
   * Handles `mouseover`/`mouseout`/`focus`/`blur` event.
   * @param {string} state `over` to show the tooltip, `out` to hide the tooltip.
   * @param {Element} [relatedTarget] For handing `mouseout` event, indicates where the mouse pointer is gone.
   */
  _handleHover = (state, relatedTarget) => {
    if (state === 'over') {
      this.getTriggerPosition();
      this.setState({ open: true });
    } else {
      // Note: SVGElement in IE11 does not have `.contains()`
      const shouldPreventClose =
        relatedTarget &&
        ((this.triggerEl &&
          this.triggerEl.contains &&
          this.triggerEl.contains(relatedTarget)) ||
          (this._tooltipEl && this._tooltipEl.contains(relatedTarget)));
      if (!shouldPreventClose) {
        this.setState({ open: false });
      }
    }
  };

  /**
   * The debounced version of the `mouseover`/`mouseout`/`focus`/`blur` event handler.
   * @type {Function}
   * @private
   */
  _debouncedHandleHover = null;

  /**
   * @returns {Element} The DOM element where the floating menu is placed in.
   */
  _getTarget = () =>
    (this.triggerEl &&
      closest(this.triggerEl, '[data-floating-menu-container]')) ||
    document.body;

  handleMouse = evt => {
    const state = {
      mouseover: 'over',
      mouseout: 'out',
      focus: 'over',
      blur: 'out',
      click: 'click',
    }[evt.type];
    const hadContextMenu = this._hasContextMenu;
    this._hasContextMenu = evt.type === 'contextmenu';
    if (this.props.clickToOpen) {
      if (state === 'click') {
        evt.stopPropagation();
        const shouldOpen = !this.state.open;
        if (shouldOpen) {
          this.getTriggerPosition();
        }
        this.setState({ open: shouldOpen });
      }
    } else if (
      state &&
      (state !== 'out' || !hadContextMenu) &&
      this._debouncedHandleHover
    ) {
      this._debouncedHandleHover(state, evt.relatedTarget);
    }
  };

  handleClickOutside = evt => {
    const shouldPreventClose =
      evt &&
      evt.target &&
      this._tooltipEl &&
      this._tooltipEl.contains(evt.target);
    if (!shouldPreventClose) {
      this.setState({ open: false });
    }
  };

  handleKeyPress = evt => {
    const key = evt.key || evt.which;

    if (key === 'Enter' || key === 13 || key === ' ' || key === 32) {
      evt.stopPropagation();
      this.setState({ open: !this.state.open });
    }
  };

  render() {
    const {
      triggerId = (this.triggerId =
        this.triggerId ||
        `__carbon-tooltip-trigger_${Math.random()
          .toString(36)
          .substr(2)}`),
      tooltipId = (this.tooltipId =
        this.tooltipId ||
        `__carbon-tooltip_${Math.random()
          .toString(36)
          .substr(2)}`),
      children,
      className,
      triggerClassName,
      direction,
      triggerText,
      showIcon,
      icon,
      iconName,
      iconTitle,
      iconDescription,
      renderIcon,
      menuOffset,
      // Exclude `clickToOpen` from `other` to avoid passing it along to `<div>`
      clickToOpen,
      tabIndex = 0,
      ...other
    } = this.props;

    if (!clickToOpen && __DEV__) {
      warning(
        didWarnAboutDeprecation,
        'The `clickToOpen=false` option in `Tooltip` component is being updated in the next release of ' +
          '`carbon-components-react`. Please use `TooltipIcon` or `TooltipDefinition` instead.'
      );
      didWarnAboutDeprecation = true;
    }

    const { open } = this.state;

    const tooltipClasses = classNames(
      `${prefix}--tooltip`,
      { [`${prefix}--tooltip--shown`]: open },
      className
    );

    const triggerClasses = classNames(
      { [`${prefix}--tooltip__trigger`]: !componentsX },
      { [`${prefix}--tooltip__label`]: componentsX },
      triggerClassName
    );
    const ariaOwnsProps = !open
      ? {}
      : {
          'aria-owns': tooltipId,
        };

    const IconCustomElement = renderIcon || (componentsX && Information);

    const finalIcon = IconCustomElement ? (
      <IconCustomElement
        name={iconName}
        aria-labelledby={triggerId}
        aria-label={iconDescription}
        ref={node => {
          this.triggerEl = node;
        }}
      />
    ) : (
      <Icon
        icon={!icon && !iconName ? iconInfoGlyph : icon}
        name={iconName}
        description={iconDescription}
        iconTitle={iconTitle}
        iconRef={node => {
          this.triggerEl = node;
        }}
      />
    );

    return (
      <>
        <ClickListener onClickOutside={this.handleClickOutside}>
          {showIcon ? (
            <div className={triggerClasses}>
              {triggerText}
              <div
                role="button"
                id={triggerId}
                className={componentsX ? `${prefix}--tooltip__trigger` : null}
                tabIndex={tabIndex}
                onClick={this.handleMouse}
                onKeyDown={this.handleKeyPress}
                onMouseOver={this.handleMouse}
                onMouseOut={this.handleMouse}
                onFocus={this.handleMouse}
                onBlur={this.handleMouse}
                aria-haspopup="true"
                aria-label={iconDescription}
                aria-expanded={open}
                {...ariaOwnsProps}>
                {finalIcon}
              </div>
            </div>
          ) : (
            <div
              role="button"
              tabIndex={tabIndex}
              id={triggerId}
              className={triggerClasses}
              ref={node => {
                this.triggerEl = node;
              }}
              onMouseOver={this.handleMouse}
              onMouseOut={this.handleMouse}
              onFocus={this.handleMouse}
              onBlur={this.handleMouse}
              aria-haspopup="true"
              aria-expanded={open}
              {...ariaOwnsProps}>
              {triggerText}
            </div>
          )}
        </ClickListener>
        {open && (
          <FloatingMenu
            target={this._getTarget}
            menuPosition={this.state.triggerPosition}
            menuDirection={direction}
            menuOffset={menuOffset}
            menuRef={node => {
              this._tooltipEl = node;
            }}>
            <div
              id={tooltipId}
              className={tooltipClasses}
              {...other}
              data-floating-menu-direction={direction}
              aria-labelledby={triggerId}
              onMouseOver={this.handleMouse}
              onMouseOut={this.handleMouse}
              onFocus={this.handleMouse}
              onBlur={this.handleMouse}
              onContextMenu={this.handleMouse}
              role="tooltip">
              <span className={`${prefix}--tooltip__caret`} />
              {children}
            </div>
          </FloatingMenu>
        )}
      </>
    );
  }
}
